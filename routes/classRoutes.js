const express = require('express');
const router = express.Router();
const Classroom = require('../models/Classroom'); // Assurez-vous que ce chemin est correct
const User = require('../models/user'); // Assurez-vous que ce chemin est correct

const isAuthenticated = require('../middleware/isAuthenticated');
const isClassMember = require('../middleware/isClassMember'); // Utilisé pour les routes :id

// NOUVEAUX IMPORTS POUR L'UPLOAD CLOUDINARY
const multer = require('multer');
const cloudinary = require('cloudinary').v2; // Assurez-vous que Cloudinary est bien configuré globalement dans server.js
const path = require('path'); // Nécessaire pour path.extname dans fileFilter

// --- Multer Configuration pour l'upload de fichiers de classe vers Cloudinary ---
// Cette instance de Multer est spécifique aux fichiers de classe, utilisant memoryStorage.
const classFileUpload = multer({
    storage: multer.memoryStorage(), // TRÈS IMPORTANT : stocke le fichier en mémoire
    limits: { fileSize: 10 * 1024 * 1024 }, // Limite de taille de fichier à 10 MB pour images, PDF, Word
    fileFilter: (req, file, cb) => {
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

// --- NOUVELLE ROUTE : POST / (pour créer une nouvelle classe) ---
// Cette route sera accessible via POST /classes grâce à app.use('/classes', classRoutes) dans server.js
router.post('/', isAuthenticated, async (req, res) => {
    try {
        // Vérification du rôle du professeur directement dans la route
        if (!req.session.user || req.session.user.role !== 'teacher') {
            console.warn(`Tentative de création de classe non autorisée par: ${req.session.user ? req.session.user.username : 'Utilisateur non connecté'}`);
            return res.status(403).redirect('/teacher/dashboard?error=' + encodeURIComponent('Accès interdit. Seuls les professeurs peuvent créer des classes.'));
        }

        const { name, classCode } = req.body; // Récupère les données du formulaire de création de classe
        const teacherId = req.session.user._id; // L'ID du professeur connecté

        // Log pour le débogage
        console.log('--- Tentative de Création de Classe ---');
        console.log(`Nom: ${name}, Code: ${classCode}, Professeur ID: ${teacherId}`);

        // Vérifiez si le code de classe existe déjà
        const existingClass = await Classroom.findOne({ classCode });
        if (existingClass) {
            console.warn(`Échec création classe: Code de classe '${classCode}' déjà utilisé.`);
            // Rediriger vers le tableau de bord du professeur avec un message d'erreur
            return res.redirect('/teacher/dashboard?error=' + encodeURIComponent('Un cours avec ce code existe déjà. Veuillez en choisir un autre.'));
        }

        const newClassroom = new Classroom({
            name,
            classCode,
            teacher: teacherId,
            students: [],
            messages: [],
            files: [],
            // Assurez-vous d'ajouter ces champs si votre modèle Classroom les a
            // assignments: [],
            // announcements: []
        });

        await newClassroom.save();
        console.log(`Classe '${newClassroom.name}' créée avec succès. ID: ${newClassroom._id}`);

        // Optionnel: Ajouter la classe à la liste des classes du professeur dans son document User
        // Assurez-vous que votre modèle User a un champ 'classes: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Classroom' }]'
        await User.findByIdAndUpdate(teacherId, { $push: { classes: newClassroom._id } });
        console.log(`Classe ajoutée au profil du professeur: ${req.session.user.username}`);

        // Rediriger vers le tableau de bord du professeur avec un message de succès
        res.redirect('/teacher/dashboard?message=' + encodeURIComponent('Cours créé avec succès !'));

    } catch (error) {
        console.error('Erreur lors de la création de la classe :', error);
        let errorMessage = 'Erreur serveur lors de la création du cours.';
        if (error.name === 'ValidationError') {
            errorMessage = `Erreur de validation: ${error.message}`;
        }
        res.redirect('/teacher/dashboard?error=' + encodeURIComponent(errorMessage));
    } finally {
        console.log('--- Fin Tentative de Création de Classe ---');
    }
});
// -----------------------------------------------------------------------------------

// Get Class Details
router.get('/:id', isAuthenticated, isClassMember, async (req, res) => {
    try {
        const classroom = await Classroom.findById(req.params.id)
            .populate('teacher', 'username') // Populer le professeur avec son username
            .populate({
                path: 'messages',
                populate: {
                    path: 'sender',
                    select: 'username' // Populer l'expéditeur de chaque message avec son username
                }
            })
            .populate('students', 'username') // Populer les étudiants avec leur username
            .populate({
                path: 'files',
                populate: {
                    path: 'uploader',
                    select: 'username' // Populer l'uploader de chaque fichier avec son username
                }
            });

        if (!classroom) {
            console.warn(`Classroom with ID ${req.params.id} not found.`);
            return res.status(404).render('error', { message: 'Classe introuvable.' });
        }

        // --- DEBUGGING: LOG THE CLASSROOM OBJECT BEFORE RENDERING ---
        console.log('--- Classroom Object Sent to EJS ---');
        console.log(JSON.stringify(classroom, null, 2)); // Use stringify for better logging of Mongoose objects
        console.log(`Number of messages: ${classroom.messages ? classroom.messages.length : 0}`);
        console.log(`Number of files: ${classroom.files ? classroom.files.length : 0}`);
        if (classroom.messages && classroom.messages.length > 0) {
            console.log('First message details:');
            console.log(`  Sender: ${classroom.messages[0].sender ? classroom.messages[0].sender.username : 'N/A'}`);
            console.log(`  Content: ${classroom.messages[0].content}`);
            console.log(`  Timestamp: ${classroom.messages[0].timestamp}`);
        }
        console.log('------------------------------------');
        // --- END DEBUGGING LOGS ---

        res.render('class_details', { classroom, user: req.session.user });

    } catch (error) {
        console.error("Error retrieving class details:", error);
        res.status(500).render('error', { message: 'Erreur serveur lors de l\'accès aux détails de la classe.' });
    }
});

// Create a new message in the classroom chat
// Note: This route is likely bypassed by Socket.IO for real-time chat.
// Keep it only if you have a non-Socket.IO message submission form elsewhere.
router.post('/:id/messages', isAuthenticated, isClassMember, async (req, res) => {
    try {
        const { content } = req.body;
        const classroom = await Classroom.findById(req.params.id);

        if (!classroom) {
            return res.status(404).json({ message: 'Classe introuvable.' });
        }

        // IMPORTANT: If you are using Socket.IO for chat, this route is likely redundant.
        // The Socket.IO handler in server.js should be responsible for saving messages.
        // This is a fallback or for non-realtime message submission.
        const newMessage = {
            sender: req.session.user._id, // User ID from session
            content: content,
            type: 'text', // Assuming this route only handles text messages
            timestamp: new Date()
        };

        classroom.messages.push(newMessage);
        await classroom.save();

        // After saving, get the populated message to emit via socket.io
        // Find the newly added message and populate its sender
        const savedMessage = classroom.messages[classroom.messages.length - 1];
        await User.populate(savedMessage, { path: 'sender', select: 'username' });

        // Emit message to all clients in the classroom's socket.io room
        // This requires `io` instance to be accessible, usually via `req.app.get('io')`
        if (req.app.get('io')) {
             req.app.get('io').to(req.params.id).emit('message', {
                 senderId: savedMessage.sender._id,
                 senderUsername: savedMessage.sender.username, // Use username for display
                 content: savedMessage.content,
                 type: savedMessage.type,
                 timestamp: savedMessage.timestamp
             });
        } else {
            console.warn("Socket.IO instance not available in classRoutes for message emission.");
        }


        res.status(201).json({ message: 'Message envoyé.' });
    } catch (error) {
        console.error("Error sending message:", error);
        res.status(500).json({ message: 'Erreur serveur lors de l\'envoi du message.' });
    }
});

---

## Corrected Class File Upload Route

I've updated the `router.post('/:id/files', ...)` route to correctly handle different file types (images, PDFs, Word docs) for Cloudinary uploads. This includes setting the correct `resource_type`, generating a proper `public_id` (with extension for raw files), and using the `type: 'authenticated'` parameter for PDFs and Word documents to ensure they are accessible.

```javascript
// Upload a file to the classroom
router.post('/:id/files', isAuthenticated, isClassMember, classFileUpload.single('classFile'), async (req, res) => {
    try {
        const classId = req.params.id;
        const classroom = await Classroom.findById(classId);

        if (!classroom) {
            res.locals.error = 'Classe introuvable.';
            return res.redirect(`/classes/${classId}`);
        }

        if (!req.file) {
            let errorMessage = 'Aucun fichier n\'a été sélectionné.';
            res.locals.error = errorMessage;
            return res.redirect(`/classes/${classId}`);
        }

        const { category } = req.body;

        const allowedCategories = ['exercise', 'homework', 'correction', 'general'];
        if (!category || !allowedCategories.includes(category)) {
            res.locals.error = 'Catégorie de fichier invalide. Choisissez parmi Exercice, Devoir, Correction, Général.';
            return res.redirect(`/classes/${classId}`);
        }

        console.log('--- Démarrage du processus d\'upload de fichier de classe ---');
        console.log('1. Objet req.file reçu par Multer:', req.file);
        if (req.file && req.file.buffer) {
            console.log('    -> Multer a stocké le fichier en mémoire (buffer existe). Taille:', req.file.buffer.length, 'octets.');
        } else if (req.file && req.file.path) {
            console.log('    -> ATTENTION: Multer a stocké le fichier sur disque (path existe). Chemin:', req.file.path);
        } else {
            console.log('    -> req.file est inattendu ou vide.');
        }

        const b64 = Buffer.from(req.file.buffer).toString('base64');
        let dataURI = 'data:' + req.file.mimetype + ';base64,' + b64;

        console.log('2. Tentative d\'upload vers Cloudinary...');

        // --- START OF CRITICAL CORRECTIONS FOR CLOUDINARY UPLOAD ---
        let classFileResourceType;
        const folderName = `class_files/${classId}`;
        const originalBaseName = path.parse(req.file.originalname).name;
        const fileExtension = path.extname(req.file.originalname).toLowerCase();
        const uniqueSuffix = Date.now();
        let customPublicId;

        if (req.file.mimetype.startsWith('image/')) {
            classFileResourceType = 'image';
            // For IMAGES: public_id should NOT include the file extension.
            customPublicId = `${folderName}/${originalBaseName}_${uniqueSuffix}`;
        } else if (fileExtension === '.pdf' || fileExtension === '.doc' || fileExtension === '.docx') {
            classFileResourceType = 'raw';
            // For RAW files (PDF, DOCX): public_id MUST include the file extension.
            customPublicId = `${folderName}/${originalBaseName}_${uniqueSuffix}${fileExtension}`;
        } else {
            // Fallback for other file types, using 'auto' detection by Cloudinary
            classFileResourceType = 'auto';
            customPublicId = `${folderName}/${originalBaseName}_${uniqueSuffix}${fileExtension}`;
        }

        const cloudinaryUploadResult = await cloudinary.uploader.upload(dataURI, {
            public_id: customPublicId,
            resource_type: classFileResourceType,
            unique_filename: false,
            overwrite: true,
            type: classFileResourceType === 'raw' ? 'authenticated' : 'upload'
        });
        // --- END OF CRITICAL CORRECTIONS FOR CLOUDINARY UPLOAD ---


        console.log('3. Résultat de l\'upload Cloudinary:', cloudinaryUploadResult);
        if (cloudinaryUploadResult && cloudinaryUploadResult.secure_url) {
            console.log('    -> URL sécurisée Cloudinary reçue:', cloudinaryUploadResult.secure_url);
        } else {
            console.error('    -> ERREUR: Cloudinary secure_url manquante ou upload échoué !');
            res.locals.error = 'Erreur: Cloudinary n\'a pas retourné d\'URL pour le fichier.';
            return res.redirect(`/classes/${classId}`);
        }

        // Adjust fileUrl for raw files if extension is missing (Cloudinary's behavior)
        let fileUrl = cloudinaryUploadResult.secure_url;
        const originalFullName = req.file.originalname;
        const detectedExtension = path.extname(originalFullName).toLowerCase();

        // This ensures the URL for raw files ends with the correct extension,
        // as Cloudinary's 'raw' URLs might sometimes omit it in the direct path.
        if (cloudinaryUploadResult.resource_type === 'raw' && detectedExtension && !fileUrl.toLowerCase().endsWith(detectedExtension)) {
            fileUrl += detectedExtension;
        }

        const publicId = cloudinaryUploadResult.public_id;

        const newFile = {
            fileName: req.file.originalname,
            filePath: fileUrl,
            fileSize: req.file.size,
            fileMimeType: req.file.mimetype,
            uploadDate: new Date(),
            uploader: req.session.user._id,
            category: category,
            publicId: publicId
        };

        console.log('4. Objet newFile prêt à être sauvegardé :', newFile);

        classroom.files.push(newFile);
        await classroom.save();

        res.locals.success = 'Fichier uploadé et enregistré avec succès !';
        res.redirect(`/classes/${classId}`);
    } catch (error) {
        console.error('Erreur CRITIQUE lors de l\'upload du fichier de classe (Dépôt) :', error);
        let errorMessage = 'Erreur serveur lors de l\'upload du fichier : ' + error.message;
        if (error instanceof multer.MulterError) {
            if (error.code === 'LIMIT_FILE_SIZE') {
                errorMessage = 'Le fichier est trop volumineux (max 10MB) !';
            }
        } else if (error.message.includes('Type de fichier non autorisé')) {
            errorMessage = 'Type de fichier non autorisé !';
        }
        res.locals.error = errorMessage;
        res.redirect(`/classes/${req.params.id}`);
    }
});

module.exports = router;
