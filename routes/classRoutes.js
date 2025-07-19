const express = require('express');
const router = express.Router();
const Classroom = require('../models/Classroom'); // Make sure this path is correct
const User = require('../models/user'); // Assuming you have a User model
const isAuthenticated = require('../middleware/isAuthenticated');
const isClassMember = require('../middleware/isClassMember'); // Used for :id routes
const upload = require('../middleware/upload'); // Assuming you have an upload middleware for files

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

// Upload a file to the classroom
router.post('/:id/files', isAuthenticated, isClassMember, upload.single('classFile'), async (req, res) => {
    try {
        const classroom = await Classroom.findById(req.params.id);
        if (!classroom) {
            return res.status(404).render('error', { message: 'Classe introuvable.' });
        }

        if (!req.file) {
            return res.status(400).render('error', { message: 'Aucun fichier n\'a été uploadé.' });
        }

        const { category, folder } = req.body;

        const allowedCategories = ['exercise', 'homework', 'correction', 'general'];
        if (!category || !allowedCategories.includes(category)) {
            return res.redirect(`/classes/${req.params.id}?error=${encodeURIComponent('Catégorie de fichier invalide. Choisissez parmi Exercice, Devoir, Correction, Général.')}`);
        }

        const newFile = {
            fileName: req.file.originalname,
            filePath: req.file.path,
            fileSize: req.file.size,
            fileMimeType: req.file.mimetype,
            uploader: req.session.user._id,
            uploadDate: new Date(),
            category: category,
            folder: folder || 'General'
        };

        classroom.files.push(newFile);
        await classroom.save();

        res.redirect(`/classes/${req.params.id}?message=${encodeURIComponent('Fichier uploadé avec succès !')}`);
    } catch (error) {
        console.error("Error uploading file:", error);
        let errorMessage = 'Erreur serveur lors de l\'upload du fichier.';
        if (error.name === 'ValidationError') {
            errorMessage = `Erreur de validation: ${error.message}`;
        } else if (error.message.includes('file type')) {
            errorMessage = error.message;
        }
        res.redirect(`/classes/${req.params.id}?error=${encodeURIComponent(errorMessage)}`);
    }
});

module.exports = router;
