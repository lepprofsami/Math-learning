const express = require('express');
const router = express.Router();
const Classroom = require('../models/Classroom'); // Assurez-vous que ce chemin est correct
const User = require('../models/user'); // Assurez-vous que ce chemin est correct

const isAuthenticated = require('../middleware/isAuthenticated');
const isClassMember = require('../middleware/isClassMember');

// NOUVEAUX IMPORTS POUR L'UPLOAD CLOUDINARY
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const path = require('path');

// --- Multer Configuration pour l'upload de fichiers de classe vers Cloudinary ---
const classFileUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 }, // Limite de taille de fichier à 10 MB
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
router.post('/', isAuthenticated, async (req, res) => {
    try {
        if (!req.session.user || req.session.user.role !== 'teacher') {
            console.warn(`Tentative de création de classe non autorisée par: ${req.session.user ? req.session.user.username : 'Utilisateur non connecté'}`);
            return res.status(403).redirect('/teacher/dashboard?error=' + encodeURIComponent('Accès interdit. Seuls les professeurs peuvent créer des classes.'));
        }

        const { name, classCode } = req.body;
        const teacherId = req.session.user._id;

        console.log('--- Tentative de Création de Classe ---');
        console.log(`Nom: ${name}, Code: ${classCode}, Professeur ID: ${teacherId}`);

        const existingClass = await Classroom.findOne({ classCode });
        if (existingClass) {
            console.warn(`Échec création classe: Code de classe '${classCode}' déjà utilisé.`);
            return res.redirect('/teacher/dashboard?error=' + encodeURIComponent('Un cours avec ce code existe déjà. Veuillez en choisir un autre.'));
        }

        const newClassroom = new Classroom({
            name,
            classCode,
            teacher: teacherId,
            students: [],
            messages: [],
            files: [],
        });

        await newClassroom.save();
        console.log(`Classe '${newClassroom.name}' créée avec succès. ID: ${newClassroom._id}`);

        await User.findByIdAndUpdate(teacherId, { $push: { classes: newClassroom._id } });
        console.log(`Classe ajoutée au profil du professeur: ${req.session.user.username}`);

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
            .populate('teacher', 'username')
            .populate({
                path: 'messages',
                populate: {
                    path: 'sender',
                    select: 'username'
                }
            })
            .populate('students', 'username')
            .populate({
                path: 'files',
                populate: {
                    path: 'uploader',
                    select: 'username'
                }
            });

        if (!classroom) {
            console.warn(`Classroom with ID ${req.params.id} not found.`);
            return res.status(404).render('error', { message: 'Classe introuvable.' });
        }

        console.log('--- Classroom Object Sent to EJS ---');
        console.log(JSON.stringify(classroom, null, 2));
        console.log(`Number of messages: ${classroom.messages ? classroom.messages.length : 0}`);
        console.log(`Number of files: ${classroom.files ? classroom.files.length : 0}`);
        if (classroom.messages && classroom.messages.length > 0) {
            console.log('First message details:');
            console.log(`  Sender: ${classroom.messages[0].sender ? classroom.messages[0].sender.username : 'N/A'}`);
            console.log(`  Content: ${classroom.messages[0].content}`);
            console.log(`  Timestamp: ${classroom.messages[0].timestamp}`);
        }
        console.log('------------------------------------');

        res.render('class_details', { classroom, user: req.session.user });

    } catch (error) {
        console.error("Error retrieving class details:", error);
        res.status(500).render('error', { message: 'Erreur serveur lors de l\'accès aux détails de la classe.' });
    }
});

// Create a new message in the classroom chat
router.post('/:id/messages', isAuthenticated, isClassMember, async (req, res) => {
    try {
        const { content } = req.body;
        const classroom = await Classroom.findById(req.params.id);

        if (!classroom) {
            return res.status(404).json({ message: 'Classe introuvable.' });
        }

        const newMessage = {
            sender: req.session.user._id,
            content: content,
            type: 'text',
            timestamp: new Date()
        };

        classroom.messages.push(newMessage);
        await classroom.save();

        const savedMessage = classroom.messages[classroom.messages.length - 1];
        await User.populate(savedMessage, { path: 'sender', select: 'username' });

        if (req.app.get('io')) {
             req.app.get('io').to(req.params.id).emit('message', {
                 senderId: savedMessage.sender._id,
                 senderUsername: savedMessage.sender.username,
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

        let classFileResourceType;
        const folderName = `class_files/${classId}`;
        const originalBaseName = path.parse(req.file.originalname).name;
        const fileExtension = path.extname(req.file.originalname).toLowerCase();
        const uniqueSuffix = Date.now();
        let customPublicId;

        if (req.file.mimetype.startsWith('image/')) {
            classFileResourceType = 'image';
            customPublicId = `${folderName}/${originalBaseName}_${uniqueSuffix}`;
        } else if (fileExtension === '.pdf' || fileExtension === '.doc' || fileExtension === '.docx') {
            classFileResourceType = 'raw';
            customPublicId = `${folderName}/${originalBaseName}_${uniqueSuffix}${fileExtension}`;
        } else {
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

        console.log('3. Résultat de l\'upload Cloudinary:', cloudinaryUploadResult);
        if (cloudinaryUploadResult && cloudinaryUploadResult.secure_url) {
            console.log('    -> URL sécurisée Cloudinary reçue:', cloudinaryUploadResult.secure_url);
        } else {
            console.error('    -> ERREUR: Cloudinary secure_url manquante ou upload échoué !');
            res.locals.error = 'Erreur: Cloudinary n\'a pas retourné d\'URL pour le fichier.';
            return res.redirect(`/classes/${classId}`);
        }

        let fileUrl = cloudinaryUploadResult.secure_url;
        const originalFullName = req.file.originalname;
        const detectedExtension = path.extname(originalFullName).toLowerCase();

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
