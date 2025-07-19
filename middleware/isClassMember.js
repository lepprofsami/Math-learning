// middleware/isClassMember.js
const Classroom = require('../models/Classroom'); // Assurez-vous que le chemin est correct

const isClassMember = async (req, res, next) => {
    try {
        const classId = req.params.id; // L'ID de la classe est généralement dans req.params.id
        const userId = req.session.user._id; // L'ID de l'utilisateur connecté

        if (!userId) {
            console.log('User ID not found in session.');
            return res.status(403).render('error', { message: 'Accès non autorisé : Veuillez vous connecter.' });
        }

        const classroom = await Classroom.findById(classId);

        if (!classroom) {
            console.log(`Classroom with ID ${classId} not found.`);
            return res.status(404).render('error', { message: 'Classe introuvable.' });
        }

        // Vérifier si l'utilisateur est le professeur de la classe
        const isTeacher = classroom.teacher && classroom.teacher.equals(userId);

        // Vérifier si l'utilisateur est un étudiant de la classe
        const isStudent = classroom.students.some(studentId => studentId.equals(userId));

        if (isTeacher || isStudent) {
            // L'utilisateur est membre de la classe, continuez
            next();
        } else {
            console.log(`User ${userId} is not a member of class ${classId}.`);
            res.status(403).render('error', { message: 'Accès non autorisé : Vous n\'êtes pas membre de cette classe.' });
        }
    } catch (error) {
        console.error('Error in isClassMember middleware:', error);
        res.status(500).render('error', { message: 'Erreur serveur lors de la vérification de l\'accès à la classe.' });
    }
};

module.exports = isClassMember;