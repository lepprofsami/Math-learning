const express = require('express');
const multer = require('multer');
const mongoose = require('mongoose');
const session = require('express-session');
const http = require('http');
const MongoStore = require('connect-mongo');
const path = require('path');
const socketIo = require('socket.io');
require('dotenv').config();

// --- NOUVEL IMPORT CLOUDINARY ---
const cloudinary = require('cloudinary').v2;

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// --- Configuration Cloudinary ---
// Ces informations sont lues depuis les variables d'environnement
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});
// ---------------------------------------------

// --- MongoDB Connection ---
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/math_learning';

mongoose.connect(MONGODB_URI)
    .then(() => console.log('Connexion à MongoDB réussie !'))
    .catch(err => console.error('Erreur de connexion à MongoDB :', err));

// --- Middleware Setup ---
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Configuration du moteur de vues EJS
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('io', io);

// Servir les fichiers statiques (CSS, JS côté client, images)
app.use(express.static(path.join(__dirname, 'public')));

// --- Session Configuration avec connect-mongo ---
const sessionMiddleware = session({
    secret: process.env.SESSION_SECRET || 'your_secret_key',
    resave: false,
    saveUninitialized: false,
    store: MongoStore.create({
        mongoUrl: MONGODB_URI,
        collectionName: 'sessions',
        ttl: 14 * 24 * 60 * 60,
        autoRemove: 'interval',
        autoRemoveInterval: 10
    })
});

app.use(sessionMiddleware);

// --- Middleware pour rendre 'user' et les messages flash disponibles dans toutes les vues EJS ---
app.use((req, res, next) => {
    res.locals.user = req.session.user;
    next();
});

// --- Multer Configuration pour l'upload vers Cloudinary ---
const upload = multer({
    storage: multer.memoryStorage(), // TRÈS IMPORTANT : stocke le fichier en mémoire, pas sur le disque
    limits: { fileSize: 10 * 1024 * 1024 }, // Limite de taille de fichier à 10 MB pour images, PDF, Word
    fileFilter: (req, file, cb) => {
        if (!file || !file.originalname) {
            console.error('Multer fileFilter: Fichier ou originalname manquant/null.', file);
            return cb(new Error('Fichier invalide ou nom de fichier manquant.'));
        }

        const allowedMimeTypes = /jpeg|jpg|png|gif|pdf|doc|docx/;
        const mimetype = allowedMimeTypes.test(file.mimetype);
        const extname = allowedMimeTypes.test(path.extname(file.originalname).toLowerCase());

        if (mimetype && extname) {
            return cb(null, true);
        }
        cb(new Error('Seuls les fichiers images (jpeg, jpg, png, gif), PDF, DOC et DOCX sont autorisés !'));
    }
});
// --------------------------------------------------------------------------

// --- Import des modèles et routes ---
const Classroom = require('./models/Classroom'); // Assurez-vous que le modèle Classroom est bien importé

const authRoutes = require('./routes/auth');
const dashboardRoutes = require('./routes/dashboard');
const classRoutes = require('./routes/classRoutes'); // Assurez-vous que cette route existe et gère vos vues de classe

// --- Middleware pour vérifier l'authentification ---
function isLoggedIn(req, res, next) {
    if (req.session.user) {
        return next();
    }
    res.locals.error = 'Veuillez vous connecter pour accéder à cette page.';
    res.redirect('/login');
}

// --- Routes Générales ---
app.use('/', authRoutes);
app.use('/', dashboardRoutes);
app.use('/classes', classRoutes); // Assurez-vous que les routes définies dans classRoutes ne rentrent pas en conflit

// --- API Route pour l'upload de fichiers dans le CHAT vers Cloudinary ---
app.post('/api/chat/upload-file', upload.single('file'), async (req, res) => {
    if (!req.file) {
        let message = 'Aucun fichier n\'a été uploadé.';
        if (req.fileFilterError) {
            message = req.fileFilterError.message;
        } else if (req.multerError && req.multerError.code === 'LIMIT_FILE_SIZE') {
            message = 'Le fichier est trop volumineux ! Max 10MB autorisé.';
        } else if (req.multerError) {
            message = req.multerError.message;
        }
        return res.status(400).json({ success: false, message: message });
    }

    try {
        const fileType = req.file.mimetype;
        let cloudinaryResourceType = 'auto';

        if (fileType.startsWith('image/')) {
            cloudinaryResourceType = 'image';
        } else if (fileType === 'application/pdf' || fileType.includes('application/msword') || fileType.includes('application/vnd.openxmlformats-officedocument.wordprocessingml.document')) {
            cloudinaryResourceType = 'raw';
        }

        const result = await new Promise((resolve, reject) => {
            const uploadStream = cloudinary.uploader.upload_stream(
                {
                    resource_type: cloudinaryResourceType,
                    folder: 'chat_uploads',
                    // MODIFICATIONS ICI POUR LE CHAT :
                    public_id: req.file.originalname, // Utiliser le nom original complet
                    unique_filename: true // Gérer les noms de fichiers dupliqués
                },
                (error, result) => {
                    if (error) {
                        return reject(error);
                    }
                    resolve(result);
                }
            );
            uploadStream.end(req.file.buffer);
        });

        const publicUrl = result.secure_url;
        res.json({ success: true, fileUrl: publicUrl, fileType: req.file.mimetype, fileName: req.file.originalname });
    } catch (error) {
        console.error('Erreur lors de l\'upload vers Cloudinary (chat) :', error);
        res.status(500).json({ success: false, message: 'Erreur serveur lors de l\'upload du fichier.' });
    }
}, (error, req, res, next) => {
    if (error instanceof multer.MulterError) {
        if (error.code === 'LIMIT_FILE_SIZE') {
            return res.status(400).json({ success: false, message: 'Fichier trop volumineux ! Max 10MB autorisé.' });
        }
        return res.status(400).json({ success: false, message: error.message });
    } else if (error) {
        return res.status(400).json({ success: false, message: error.message });
    }
    next();
});


// --- ROUTE : Dépôt de Fichiers (hors chat) pour les classes ---
app.post('/classes/:classId/files', isLoggedIn, upload.single('classFile'), async (req, res) => {
    try {
        const classId = req.params.classId;
        const file = req.file;

        console.log('--- Démarrage du processus d\'upload de fichier de classe ---');
        console.log('1. Objet req.file reçu par Multer:', file);
        if (file && file.buffer) {
            console.log('    -> Multer a stocké le fichier en mémoire (buffer existe). Taille:', file.buffer.length, 'octets.');
        } else if (file && file.path) {
            console.log('    -> ATTENTION: Multer a stocké le fichier sur disque (path existe). Chemin:', file.path);
        } else {
            console.log('    -> req.file est inattendu ou vide.');
        }

        const { category } = req.body;

        if (!file) {
             let errorMessage = 'Aucun fichier n\'a été sélectionné.';
             if (req.fileFilterError) {
                 errorMessage = req.fileFilterError.message;
             } else if (req.multerError && req.multerError.code === 'LIMIT_FILE_SIZE') {
                 errorMessage = 'Le fichier est trop volumineux ! Max 10MB autorisé.';
             } else if (req.multerError) {
                 errorMessage = req.multerError.message;
             }
             res.locals.error = errorMessage;
             return res.redirect(`/classes/${classId}`);
        }

        if (!category) {
            res.locals.error = 'Veuillez sélectionner une catégorie pour le fichier.';
            return res.redirect(`/classes/${classId}`);
        }

        const b64 = Buffer.from(file.buffer).toString('base64');
        let dataURI = 'data:' + file.mimetype + ';base64,' + b64;

        console.log('2. Tentative d\'upload vers Cloudinary...');

        let classFileResourceType = 'auto';
        if (file.mimetype.startsWith('image/')) {
            classFileResourceType = 'image';
        } else if (file.mimetype === 'application/pdf' || file.mimetype.includes('application/msword') || file.mimetype.includes('application/vnd.openxmlformats-officedocument.wordprocessingml.document')) {
            classFileResourceType = 'raw';
        }

        const cloudinaryUploadResult = await cloudinary.uploader.upload(dataURI, {
            folder: `class_files/${classId}`,
            resource_type: classFileResourceType,
            // MODIFICATIONS ICI POUR LE DÉPÔT DE FICHIERS :
            public_id: file.originalname, // Utiliser le nom original complet
            unique_filename: true // Gérer les noms de fichiers dupliqués
        });

        console.log('3. Résultat de l\'upload Cloudinary:', cloudinaryUploadResult);
        if (cloudinaryUploadResult && cloudinaryUploadResult.secure_url) {
            console.log('    -> URL sécurisée Cloudinary reçue:', cloudinaryUploadResult.secure_url);
        } else {
            console.error('    -> ERREUR: Cloudinary secure_url manquante ou upload échoué !');
        }

        const fileUrl = cloudinaryUploadResult.secure_url;
        const publicId = cloudinaryUploadResult.public_id;

        const newFile = {
            fileName: file.originalname,
            filePath: fileUrl,
            fileSize: file.size,
            fileMimeType: file.mimetype,
            uploadDate: new Date(),
            uploader: req.session.user._id,
            category: category,
            publicId: publicId
        };

        console.log('4. Objet newFile prêt à être sauvegardé :', newFile);

        const classroom = await Classroom.findById(classId);
        if (!classroom) {
            res.locals.error = 'Classe introuvable.';
            return res.redirect('/');
        }

        classroom.files.push(newFile);
        await classroom.save();

        res.locals.success = 'Fichier uploadé et enregistré avec succès !';
        res.redirect(`/classes/${classId}`);
    } catch (error) {
        console.error('Erreur CRITIQUE lors de l\'upload du fichier de classe (Dépôt) :', error);
        res.locals.error = 'Erreur lors de l\'upload du fichier : ' + error.message;
        res.redirect(`/classes/${req.params.classId}`);
    }
});


// Route principale (accueil)
app.get('/', (req, res) => {
    res.render('index', { title: 'Accueil - Math-learning' });
});

// Route de démo pour vider la DB (DEV ONLY - À RETIRER EN PRODUCTION)
app.get('/clear-db-dev-only', async (req, res) => {
    if (process.env.NODE_ENV !== 'production') {
        try {
            await mongoose.connection.dropCollection('users');
            await mongoose.connection.dropCollection('classrooms');
            await mongoose.connection.dropCollection('sessions');
            console.log('✅ Base de données (users, classrooms, sessions) vidée avec succès !');
            res.send('Base de données (users, classrooms, sessions) vidée avec succès !');
        } catch (error) {
            console.error('Erreur lors du vidage de la base de données :', error);
            res.status(500).send('Erreur lors du vidage de la base de données.');
        }
    } else {
        res.status(403).send('Accès interdit en production.');
    }
});

// --- Socket.IO connection logic ---
io.use((socket, next) => {
    sessionMiddleware(socket.request, {}, (err) => {
        if (err) {
            console.error('Erreur lors de l\'accès à la session Socket.IO:', err);
            return next(err);
        }
        next();
    });
});

io.on('connection', (socket) => {
    console.log('Un utilisateur s\'est connecté :', socket.id);

    const userInSession = socket.request.session.user;

    if (!userInSession) {
        console.log('Utilisateur non authentifié via session, déconnexion du socket.');
        return socket.disconnect(true);
    }

    socket.userId = userInSession._id;
    socket.username = userInSession.username;
    socket.userRole = userInSession.role;

    socket.on('joinRoom', (classroomId) => {
        socket.join(classroomId);
        console.log(`${socket.username} a rejoint la salle : ${classroomId}`);
    });

    // Modified chatMessage event to handle different message types
    socket.on('chatMessage', async ({ classroomId, content, type, fileUrl }) => {
        const senderId = socket.userId;
        const senderUsername = socket.username;

        if (!senderId || !senderUsername) {
            console.error('Erreur: ID ou NOM D\'UTILISATEUR de l\'expéditeur manquant sur le socket.');
            return;
        }

        console.log(`Message reçu dans la classe ${classroomId} de ${senderUsername} (Type: ${type}):`, content || fileUrl);

        try {
            const classroom = await Classroom.findById(classroomId);
            if (!classroom) {
                console.error('Classe non trouvée pour le message :', classroomId);
                return;
            }

            const newMessage = {
                sender: senderId,
                content: content,
                type: type || 'text',
                fileUrl: fileUrl,
                timestamp: new Date()
            };

            classroom.messages.push(newMessage);
            await classroom.save();

            io.to(classroomId).emit('message', {
                senderId: senderId,
                senderUsername: senderUsername,
                content: content,
                type: type || 'text',
                fileUrl: fileUrl,
                timestamp: newMessage.timestamp
            });

        } catch (error) {
            console.error('Erreur lors de l\'enregistrement ou de l\'envoi du message :', error);
        }
    });

    socket.on('disconnect', () => {
        console.log('Un utilisateur s\'est déconnecté :', socket.id);
    });
});

// --- Démarrage du serveur ---
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
