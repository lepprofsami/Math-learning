const express = require('express');
const multer = require('multer');
const mongoose = require('mongoose');
const session = require('express-session');
const http = require('http');
const MongoStore = require('connect-mongo');
const path = require('path');
const socketIo = require('socket.io');
require('dotenv').config();

const cloudinary = require('cloudinary').v2;

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// --- Cloudinary Configuration ---
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});
// ---------------------------------------------

// --- MongoDB Connection ---
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/math_learning';

mongoose.connect(MONGODB_URI)
    .then(() => console.log('Connected to MongoDB successfully!'))
    .catch(err => console.error('MongoDB connection error:', err));

// --- Middleware Setup ---
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// EJS view engine configuration
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('io', io);

// Serve static files (CSS, client-side JS, images)
app.use(express.static(path.join(__dirname, 'public')));

// --- Session Configuration with connect-mongo ---
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

// --- Middleware to make 'user' and flash messages available in all EJS views ---
app.use((req, res, next) => {
    res.locals.user = req.session.user;
    next();
});

// --- Multer Configuration for Cloudinary Upload ---
const upload = multer({
    storage: multer.memoryStorage(), // IMPORTANT: stores the file in memory, not on disk
    limits: { fileSize: 10 * 1024 * 1024 }, // File size limit to 10 MB for images, PDF, Word
    fileFilter: (req, file, cb) => {
        if (!file || !file.originalname) {
            console.error('Multer fileFilter: Missing/null file or originalname.', file);
            return cb(new Error('Invalid file or missing filename.'));
        }

        const allowedMimeTypes = /jpeg|jpg|png|gif|pdf|doc|docx/;
        const mimetype = allowedMimeTypes.test(file.mimetype);
        const extname = allowedMimeTypes.test(path.extname(file.originalname).toLowerCase());

        if (mimetype && extname) {
            return cb(null, true);
        }
        cb(new Error('Only images (jpeg, jpg, png, gif), PDF, DOC, and DOCX files are allowed!'));
    }
});
// --------------------------------------------------------------------------

// --- Import Models and Routes ---
const Classroom = require('./models/Classroom');
const authRoutes = require('./routes/auth');
const dashboardRoutes = require('./routes/dashboard');
const classRoutes = require('./routes/classRoutes');

// --- Authentication Middleware ---
function isLoggedIn(req, res, next) {
    if (req.session.user) {
        return next();
    }
    res.locals.error = 'Please log in to access this page.';
    res.redirect('/login');
}

// --- General Routes ---
app.use('/', authRoutes);
app.use('/', dashboardRoutes);
app.use('/classes', classRoutes);

// --- API Route for Chat File Upload to Cloudinary ---
app.post('/api/chat/upload-file', upload.single('file'), async (req, res) => {
    if (!req.file) {
        let message = 'No file uploaded.';
        if (req.fileFilterError) {
            message = req.fileFilterError.message;
        } else if (req.multerError && req.multerError.code === 'LIMIT_FILE_SIZE') {
            message = 'File is too large! Max 10MB allowed.';
        } else if (req.multerError) {
            message = req.multerError.message;
        }
        return res.status(400).json({ success: false, message: message });
    }

    try {
        const fileType = req.file.mimetype;
        const folderName = 'chat_uploads';

        const originalBaseName = path.parse(req.file.originalname).name;
        const fileExtension = path.extname(req.file.originalname).toLowerCase();
        const uniqueSuffix = Date.now();
        let customPublicId;
        let cloudinaryResourceType;

        if (fileType.startsWith('image/')) {
            cloudinaryResourceType = 'image';
            // For IMAGES: public_id should NOT include the file extension.
            // Cloudinary will automatically add it based on its detected format.
            customPublicId = `${folderName}/${originalBaseName}_${uniqueSuffix}`;
        } else if (fileType === 'application/pdf' || fileType.includes('application/msword') || fileType.includes('application/vnd.openxmlformats-officedocument.wordprocessingml.document')) {
            cloudinaryResourceType = 'raw';
            // For RAW files (PDF, DOCX): public_id MUST include the file extension.
            customPublicId = `${folderName}/${originalBaseName}_${uniqueSuffix}${fileExtension}`;
        } else {
            // Fallback for other file types, ideally prevented by Multer's fileFilter
            cloudinaryResourceType = 'auto';
            customPublicId = `${folderName}/${originalBaseName}_${uniqueSuffix}${fileExtension}`;
        }

        const result = await new Promise((resolve, reject) => {
            const uploadStream = cloudinary.uploader.upload_stream(
                {
                    resource_type: cloudinaryResourceType,
                    public_id: customPublicId,
                    unique_filename: false,
                    overwrite: true
                },
                (error, result) => {
                    if (error) {
                        console.error("Cloudinary upload_stream error (chat):", error);
                        return reject(error);
                    }
                    console.log("Cloudinary chat upload result:", result);
                    resolve(result);
                }
            );
            uploadStream.end(req.file.buffer);
        });

        // The URL returned by Cloudinary (result.secure_url) should now be correct due to the public_id setting.
        // The fallback logic below is still there but should rarely be needed for these cases.
        let fileUrl = result.secure_url;
        const originalFullName = req.file.originalname;
        const detectedExtension = path.extname(originalFullName).toLowerCase();

        // This condition should rarely be true now if public_id is correctly defined above.
        if (result.resource_type === 'raw' && detectedExtension && !fileUrl.toLowerCase().endsWith(detectedExtension)) {
            fileUrl += detectedExtension;
        }

        res.json({ success: true, fileUrl: fileUrl, fileType: req.file.mimetype, fileName: req.file.originalname });
    } catch (error) {
        console.error('Error during Cloudinary upload (chat):', error);
        res.status(500).json({ success: false, message: 'Server error during file upload.' });
    }
}, (error, req, res, next) => {
    if (error instanceof multer.MulterError) {
        if (error.code === 'LIMIT_FILE_SIZE') {
            return res.status(400).json({ success: false, message: 'File too large! Max 10MB allowed.' });
        }
        return res.status(400).json({ success: false, message: error.message });
    } else if (error) {
        return res.status(400).json({ success: false, message: error.message });
    }
    next();
});

// --- Route: Class File Deposit (outside chat) ---
app.post('/classes/:classId/files', isLoggedIn, upload.single('classFile'), async (req, res) => {
    try {
        const classId = req.params.classId;
        const file = req.file;

        console.log('--- Starting class file upload process ---');
        console.log('1. req.file object received by Multer:', file);
        if (file && file.buffer) {
            console.log('    -> Multer stored file in memory (buffer exists). Size:', file.buffer.length, 'bytes.');
        } else if (file && file.path) {
            console.log('    -> WARNING: Multer stored file on disk (path exists). Path:', file.path);
        } else {
            console.log('    -> req.file is unexpected or empty.');
        }

        const { category } = req.body;

        if (!file) {
             let errorMessage = 'No file selected.';
             if (req.fileFilterError) {
                 errorMessage = req.fileFilterError.message;
             } else if (req.multerError && req.multerError.code === 'LIMIT_FILE_SIZE') {
                 errorMessage = 'File is too large! Max 10MB allowed.';
             } else if (req.multerError) {
                 errorMessage = req.multerError.message;
             }
             res.locals.error = errorMessage;
             return res.redirect(`/classes/${classId}`);
        }

        if (!category) {
            res.locals.error = 'Please select a category for the file.';
            return res.redirect(`/classes/${classId}`);
        }

        const b64 = Buffer.from(file.buffer).toString('base64');
        let dataURI = 'data:' + file.mimetype + ';base64,' + b64;

        console.log('2. Attempting to upload to Cloudinary...');

        let classFileResourceType;
        const folderName = `class_files/${classId}`;

        const originalBaseName = path.parse(file.originalname).name;
        const fileExtension = path.extname(file.originalname).toLowerCase();
        const uniqueSuffix = Date.now();
        let customPublicId;

        if (file.mimetype.startsWith('image/')) {
            classFileResourceType = 'image';
            // For IMAGES: public_id should NOT include the file extension.
            customPublicId = `${folderName}/${originalBaseName}_${uniqueSuffix}`;
        } else if (file.mimetype === 'application/pdf' || file.mimetype.includes('application/msword') || file.mimetype.includes('application/vnd.openxmlformats-officedocument.wordprocessingml.document')) {
            classFileResourceType = 'raw';
            // For RAW files (PDF, DOCX): public_id MUST include the file extension.
            customPublicId = `${folderName}/${originalBaseName}_${uniqueSuffix}${fileExtension}`;
        } else {
            // Fallback for other file types
            classFileResourceType = 'auto';
            customPublicId = `${folderName}/${originalBaseName}_${uniqueSuffix}${fileExtension}`;
        }

        const cloudinaryUploadResult = await cloudinary.uploader.upload(dataURI, {
            public_id: customPublicId,
            resource_type: classFileResourceType,
            unique_filename: false,
            overwrite: true
        });

        console.log("Cloudinary class file upload result:", cloudinaryUploadResult);

        if (cloudinaryUploadResult && cloudinaryUploadResult.secure_url) {
            console.log('    -> Secure Cloudinary URL received:', cloudinaryUploadResult.secure_url);
        } else {
            console.error('    -> ERROR: Missing Cloudinary secure_url or upload failed!');
        }

        // The URL returned by Cloudinary (cloudinaryUploadResult.secure_url) should now be correct.
        // The fallback logic below is still there but should rarely be needed for these cases.
        let fileUrl = cloudinaryUploadResult.secure_url;
        const originalFullName = file.originalname;
        const detectedExtension = path.extname(originalFullName).toLowerCase();

        if (cloudinaryUploadResult.resource_type === 'raw' && detectedExtension && !fileUrl.toLowerCase().endsWith(detectedExtension)) {
            fileUrl += detectedExtension;
        }

        const publicId = cloudinaryUploadResult.public_id;

        const newFile = {
            fileName: file.originalname,
            filePath: fileUrl, // Save the potentially modified URL
            fileSize: file.size,
            fileMimeType: file.mimetype,
            uploadDate: new Date(),
            uploader: req.session.user._id,
            category: category,
            publicId: publicId
        };

        console.log('4. newFile object ready to be saved:', newFile);

        const classroom = await Classroom.findById(classId);
        if (!classroom) {
            res.locals.error = 'Classroom not found.';
            return res.redirect('/');
        }

        classroom.files.push(newFile);
        await classroom.save();

        res.locals.success = 'File uploaded and saved successfully!';
        res.redirect(`/classes/${classId}`);
    } catch (error) {
        console.error('CRITICAL Error during class file upload (Deposit):', error);
        res.locals.error = 'Error during file upload: ' + error.message;
        res.redirect(`/classes/${req.params.classId}`);
    }
});

// --- General Routes and Socket.IO ---
// Main route (home)
app.get('/', (req, res) => {
    res.render('index', { title: 'Home - Math-learning' });
});

// Demo route to clear DB (DEV ONLY - REMOVE IN PRODUCTION)
app.get('/clear-db-dev-only', async (req, res) => {
    if (process.env.NODE_ENV !== 'production') {
        try {
            await mongoose.connection.dropCollection('users');
            await mongoose.connection.dropCollection('classrooms');
            await mongoose.connection.dropCollection('sessions');
            console.log('✅ Database (users, classrooms, sessions) cleared successfully!');
            res.send('Database (users, classrooms, sessions) cleared successfully!');
        } catch (error) {
            console.error('Error clearing database:', error);
            res.status(500).send('Error clearing database.');
        }
    } else {
        res.status(403).send('Access forbidden in production.');
    }
});

// --- Socket.IO connection logic ---
io.use((socket, next) => {
    sessionMiddleware(socket.request, {}, (err) => {
        if (err) {
            console.error('Error accessing Socket.IO session:', err);
            return next(err);
        }
        next();
    });
});

io.on('connection', (socket) => {
    console.log('A user connected:', socket.id);

    const userInSession = socket.request.session.user;

    if (!userInSession) {
        console.log('User not authenticated via session, disconnecting socket.');
        return socket.disconnect(true);
    }

    socket.userId = userInSession._id;
    socket.username = userInSession.username;
    socket.userRole = userInSession.role;

    socket.on('joinRoom', (classroomId) => {
        socket.join(classroomId);
        console.log(`${socket.username} joined room: ${classroomId}`);
    });

    // Modified chatMessage event to handle different message types
    socket.on('chatMessage', async ({ classroomId, content, type, fileUrl }) => {
        const senderId = socket.userId;
        const senderUsername = socket.username;

        if (!senderId || !senderUsername) {
            console.error('Error: Sender ID or USERNAME missing on socket.');
            return;
        }

        console.log(`Message received in class ${classroomId} from ${senderUsername} (Type: ${type}):`, content || fileUrl);

        try {
            const classroom = await Classroom.findById(classroomId);
            if (!classroom) {
                console.error('Classroom not found for message:', classroomId);
                return;
            }

            const newMessage = {
                sender: senderId,
                content: content,
                type: type || 'text',
                fileUrl: fileUrl, // This is the file URL, potentially modified to have the extension
                timestamp: new Date()
            };

            classroom.messages.push(newMessage);
            await classroom.save();

            io.to(classroomId).emit('message', {
                senderId: senderId,
                senderUsername: senderUsername,
                content: content,
                type: type || 'text',
                fileUrl: fileUrl,
                timestamp: newMessage.timestamp
            });

        } catch (error) {
            console.error('Error saving or sending message:', error);
        }
    });

    socket.on('disconnect', () => {
        console.log('A user disconnected:', socket.id);
    });
});

// --- Start Server ---
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
