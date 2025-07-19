// models/Classroom.js
const mongoose = require('mongoose');
const User = require('./user'); // Assurez-vous que le modèle User est correctement importé si pas déjà

// Schema for individual file entries within a Classroom
const fileSchema = new mongoose.Schema({
    fileName: { type: String, required: true }, // Original file name
    filePath: { type: String, required: true }, // Unique path on the server
    fileSize: { type: Number, required: true }, // Size in bytes
    fileMimeType: { type: String, required: true }, // MIME type of the file (e.g., 'application/pdf')
    uploadDate: { type: Date, default: Date.now, required: true },
    uploader: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    category: {
        type: String,
        enum: ['exercise', 'homework', 'correction', 'general'],
        default: 'general',
        required: true
    },
    folder: {
        type: String,
        default: 'General',
        trim: true
    }
});

// --- MODIFICATION ICI : Schéma pour les messages de chat individuels ---
const messageSchema = new mongoose.Schema({
    sender: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    content: { // Contenu textuel ou code LaTeX
        type: String,
        required: false // Peut être false si le message est uniquement une image
    },
    type: { // Type de message: 'text', 'math', 'image'
        type: String,
        enum: ['text', 'math', 'image'],
        default: 'text',
        required: true
    },
    imageUrl: { // URL de l'image pour les messages de type 'image'
        type: String,
        required: false // Requis seulement si type est 'image'
    },
    timestamp: { type: Date, default: Date.now, required: true }
});
// ----------------------------------------------------------------------

// Main Classroom Schema
const classroomSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true,
        trim: true
    },
    classCode: {
        type: String,
        required: true,
        unique: true,
        trim: true
    },
    teacher: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    students: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    }],
    messages: [messageSchema], // This references the messageSchema defined above
    files: [fileSchema] // This references the fileSchema defined above
}, {
    timestamps: true
});

module.exports = mongoose.model('Classroom', classroomSchema);
