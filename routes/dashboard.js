// routes/dashboard.js
const express = require('express');
const router = express.Router();
const User = require('../models/user'); // Assuming you'll need the User model
const Classroom = require('../models/Classroom'); // Assuming you'll need the Classroom model
const isAuthenticated = require('../middleware/isAuthenticated');
// Middleware to ensure user is authenticated and has a role
function ensureAuthenticated(req, res, next) {
    if (req.session.user) {
        next();
    } else {
        res.redirect('/login');
    }
}

// Route for Teacher Dashboard
router.get('/teacher/dashboard', ensureAuthenticated, async (req, res) => {
    if (req.session.user.role !== 'teacher') {
        return res.redirect('/'); // Or render an unauthorized page
    }
    try {
        const teacherId = req.session.user._id;
        // Fetch classes created by this teacher
        const classes = await Classroom.find({ teacher: teacherId }).populate('students', 'username email'); // Populate students to show their names
        
        res.render('teacher_dashboard', { 
            user: req.session.user, 
            classes: classes,
            message: req.query.message, // Pass messages from redirects
            error: req.query.error // Pass errors from redirects
        });
    } catch (error) {
        console.error('Error fetching teacher dashboard data:', error);
        res.render('teacher_dashboard', { 
            user: req.session.user, 
            classes: [], // Provide empty array to prevent template errors
            error: 'Failed to load dashboard data.' 
        });
    }
});

// Route to render the student dashboard
router.get('/student/dashboard', isAuthenticated, async (req, res) => {
    // This route needs to populate the user's classroom if it's not already in session
    try {
        if (req.session.user && req.session.user._id) {
            const user = await User.findById(req.session.user._id).populate('classroom'); // Populate the 'classroom' field if it exists on the User model

            if (user && user.classroom) {
                // Update the session with classroom details
                req.session.user.classroom = user.classroom._id;
                req.session.user.classroomName = user.classroom.name;
            } else {
                // Ensure classroom data is cleared if not assigned
                req.session.user.classroom = null;
                req.session.user.classroomName = null;
            }
        }
        res.render('student_dashboard', { user: req.session.user });
    } catch (error) {
        console.error("Error rendering student dashboard:", error);
        res.status(500).render('error', { message: 'Erreur serveur lors de l\'affichage du tableau de bord.' });
    }
});


// Example Route for a Student Joining a Class (if you have one)
// If you don't have a specific route for joining, this logic needs to be placed
// where the student's 'classroom' field is set.
router.post('/student/join-class', isAuthenticated, async (req, res) => {
    const { classCode } = req.body; // Assuming the form sends a classCode

    try {
        const classroom = await Classroom.findOne({ classCode });
        if (!classroom) {
            return res.render('student_dashboard', { user: req.session.user, error: 'Code de classe invalide.' });
        }

        const studentId = req.session.user._id;
        const user = await User.findById(studentId);

        if (!user) {
            return res.status(404).render('error', { message: 'Utilisateur non trouvé.' });
        }

        // Check if student is already in this class
        if (classroom.students.includes(studentId) && user.classroom && user.classroom.equals(classroom._id)) {
            return res.render('student_dashboard', { user: req.session.user, message: 'Vous êtes déjà dans cette classe.' });
        }

        // Add student to classroom's students array
        classroom.students.push(studentId);
        await classroom.save();

        // Update the student's user document to link to the classroom
        user.classroom = classroom._id; // Assuming you have a 'classroom' field on your User model
        await user.save();

        // --- KEY CHANGE: Update the session immediately after joining ---
        req.session.user.classroom = classroom._id;
        req.session.user.classroomName = classroom.name;
        // -----------------------------------------------------------------

        // Re-save the session to ensure changes are persisted
        req.session.save((err) => {
            if (err) console.error('Error saving session after joining class:', err);
            res.redirect('/student/dashboard'); // Redirect to refresh dashboard
        });

    } catch (error) {
        console.error("Error joining class:", error);
        res.status(500).render('error', { message: 'Erreur serveur lors de la jonction de la classe.' });
    }
});

module.exports = router;
