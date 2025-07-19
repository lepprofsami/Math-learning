// middleware/isAuthenticated.js
const isAuthenticated = (req, res, next) => {
    if (req.session && req.session.user) {
        // L'utilisateur est authentifié, continuez vers la prochaine fonction middleware/route
        next();
    } else {
        // L'utilisateur n'est pas authentifié, redirigez-le vers la page de connexion
        console.log('User not authenticated, redirecting to /login');
        res.redirect('/login');
    }
};

module.exports = isAuthenticated;