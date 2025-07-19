// middleware/upload.js
const multer = require('multer');
const path = require('path');
const fs = require('fs'); // Pour créer le dossier d'uploads si nécessaire

// Définir le dossier où les fichiers seront stockés
const uploadDir = path.join(__dirname, '../uploads'); // Crée le dossier 'uploads' à la racine du projet

// Assurez-vous que le dossier d'upload existe
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

// Configurer le stockage pour Multer
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, uploadDir); // Le dossier de destination
    },
    filename: function (req, file, cb) {
        // Nom du fichier : horodatage + nom original
        cb(null, Date.now() + '-' + file.originalname);
    }
});

// Filtre pour n'accepter que certains types de fichiers (optionnel)
const fileFilter = (req, file, cb) => {
    // Accepter les images et les documents PDF/Word/Excel
    if (file.mimetype.startsWith('image/') ||
        file.mimetype === 'application/pdf' ||
        file.mimetype === 'application/msword' ||
        file.mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
        file.mimetype === 'application/vnd.ms-excel' ||
        file.mimetype === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
        file.mimetype === 'application/vnd.ms-powerpoint' ||
        file.mimetype === 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
    ) {
        cb(null, true);
    } else {
        cb(new Error('Type de fichier non autorisé.'), false);
    }
};

const upload = multer({
    storage: storage,
    fileFilter: fileFilter,
    limits: { fileSize: 1024 * 1024 * 50 } // Limite de 50 Mo par fichier
});

module.exports = upload;