// models/User.js
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs'); // Assurez-vous d'avoir bien installé bcryptjs (npm install bcryptjs)

const UserSchema = new mongoose.Schema({
    email: {
        type: String,
        required: false, // <-- CHANGEMENT CLÉ : L'email n'est plus requis à l'inscription
        unique: true,
        sparse: true,    // <-- NOUVEAU : Permet de stocker plusieurs documents avec une valeur 'null' ou 'undefined' pour email, tout en maintenant l'unicité pour les emails non-null.
        lowercase: true
    },
    password: {
        type: String,
        required: true
    },
    username: { // <-- NOUVEAU CHAMP : Nom d'utilisateur pour l'affichage et la connexion
        type: String,
        required: true,    // <-- REQUIS : L'utilisateur doit fournir un nom d'utilisateur
        unique: true,      // <-- UNIQUE : Chaque nom d'utilisateur doit être unique
        minlength: 3,      // <-- OPTIONNEL : Vous pouvez définir une longueur minimale
        trim: true         // <-- OPTIONNEL : Supprime les espaces blancs au début et à la fin
    },
    role: {
        type: String,
        enum: ['teacher', 'student'],
        required: true
    },
    classroom: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Classroom',
        required: function() { return this.role === 'student'; }
    },
    createdAt: {
        type: Date,
        default: Date.now
    }
});

// --- HOOK DE PRE-SAUVEGARDE POUR HASHER LE MOT DE PASSE ---
UserSchema.pre('save', async function(next) {
    if (this.isModified('password')) {
        this.password = await bcrypt.hash(this.password, 10);
    }
    next();
});

// --- MÉTHODE DE SCHÉMA POUR COMPARER LES MOTS DE PASSE ---
UserSchema.methods.comparePassword = async function(candidatePassword) {
    return await bcrypt.compare(candidatePassword, this.password);
};

// Exporte le modèle User
module.exports = mongoose.model('User', UserSchema);