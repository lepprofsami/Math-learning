const express = require('express');
const mongoose = require('mongoose');
const session = require('express-session');
const http = require('http');
const MongoStore = require('connect-mongo');
const path = require('path');
const socketIo = require('socket.io');
const multer = require('multer'); // Import multer
const fs = require('fs'); // Import fs for directory creation
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

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
// THIS LINE IS CRUCIAL FOR SERVING UPLOADED IMAGES
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

// --- Middleware pour rendre 'user' disponible dans toutes les vues EJS ---
app.use((req, res, next) => {
    res.locals.user = req.session.user;
    next();
});

// --- Multer Configuration for Image Uploads ---
const uploadDir = path.join(__dirname, 'public', 'uploads', 'chat-images');

// Create the upload directory if it doesn't exist
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
    console.log(`Created upload directory: ${uploadDir}`);
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadDir); // Use the defined upload directory
    },
    filename: (req, file, cb) => {
        // Generate a unique filename: timestamp-originalfilename.ext
        cb(null, Date.now() + '-' + file.originalname);
    }
});

const upload = multer({ 
    storage: storage,
    limits: { fileSize: 5 * 1024 * 1024 }, // Limit file size to 5MB
    fileFilter: (req, file, cb) => {
        // Allow only images
        const filetypes = /jpeg|jpg|png|gif/;
        const mimetype = filetypes.test(file.mimetype);
        const extname = filetypes.test(path.extname(file.originalname).toLowerCase());

        if (mimetype && extname) {
            return cb(null, true);
        }
        cb(new Error('Only images (jpeg, jpg, png, gif) are allowed!'));
    }
});

// --- Routes ---
const authRoutes = require('./routes/auth');
const dashboardRoutes = require('./routes/dashboard');
const classRoutes = require('./routes/classRoutes');
const Classroom = require('./models/Classroom'); // Ensure Classroom model is required for Socket.IO

app.use('/', authRoutes);
app.use('/', dashboardRoutes);
app.use('/classes', classRoutes);

// --- API Route for Image Upload ---
app.post('/api/chat/upload-image', upload.single('chatImage'), (req, res) => {
    if (req.file) {
        // Construct the URL path relative to the 'public' directory
        const imageUrl = `/uploads/chat-images/${req.file.filename}`;
        res.json({ success: true, imageUrl: imageUrl });
    } else {
        // Handle cases where no file was uploaded or filter failed
        let message = 'No file uploaded.';
        if (req.fileFilterError) { // Custom error message from fileFilter
            message = req.fileFilterError.message;
        } else if (req.multerError) { // Multer specific error
            message = req.multerError.message;
        }
        res.status(400).json({ success: false, message: message });
    }
}, (error, req, res, next) => { // Multer error handling middleware
    if (error instanceof multer.MulterError) {
        if (error.code === 'LIMIT_FILE_SIZE') {
            return res.status(400).json({ success: false, message: 'File too large! Max 5MB allowed.' });
        }
        return res.status(400).json({ success: false, message: error.message });
    } else if (error) {
        // Handle other errors, e.g., from fileFilter
        return res.status(400).json({ success: false, message: error.message });
    }
    next();
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
        // console.log('Session Socket.IO après middleware:', socket.request.session); // Can be verbose, uncomment for debugging
        next();
    });
});

io.on('connection', (socket) => {
    console.log('Un utilisateur s\'est connecté :', socket.id);

    const userInSession = socket.request.session.user;

    // console.log('Utilisateur dans la session Socket.IO (au moment de la connexion) :', userInSession); // Can be verbose

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
    socket.on('chatMessage', async ({ classroomId, content, type, imageUrl }) => {
        const senderId = socket.userId;
        const senderUsername = socket.username;

        if (!senderId || !senderUsername) {
            console.error('Erreur: ID ou NOM D\'UTILISATEUR de l\'expéditeur manquant sur le socket.');
            return;
        }

        console.log(`Message reçu dans la classe ${classroomId} de ${senderUsername} (Type: ${type}):`, content || imageUrl);

        try {
            const classroom = await Classroom.findById(classroomId);
            if (!classroom) {
                console.error('Classe non trouvée pour le message :', classroomId);
                return;
            }

            const newMessage = {
                sender: senderId,
                content: content,
                type: type || 'text', // Default to 'text' if not specified
                imageUrl: imageUrl, // Will be undefined if not an image message
                timestamp: new Date()
            };

            classroom.messages.push(newMessage);
            await classroom.save();

            // Emit the message to the room
            io.to(classroomId).emit('message', {
                senderId: senderId,
                senderUsername: senderUsername,
                content: content,
                type: type || 'text',
                imageUrl: imageUrl,
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