const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const multer = require('multer');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Middleware
app.use(express.static('public'));
app.use(express.json());

// File upload configuration
const storage = multer.memoryStorage();
const upload = multer({
    storage: storage,
    limits: {
        fileSize: 2 * 1024 * 1024 // 2MB limit
    },
    fileFilter: (req, file, cb) => {
        const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif'];
        if (allowedTypes.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('Invalid file type'), false);
        }
    }
});

// In-memory storage
const activeUsers = new Map();
const messages = [];

// Sanitize text input
function sanitizeText(text) {
    return text.replace(/[<>]/g, (match) => {
        return match === '<' ? '&lt;' : '&gt;';
    }).trim();
}

// Socket.IO connection handling
io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    socket.on('join', (username) => {
        const sanitizedUsername = sanitizeText(username);
        if (!sanitizedUsername || sanitizedUsername.length > 50) {
            socket.emit('error', 'Invalid username');
            return;
        }

        const userId = uuidv4();
        activeUsers.set(socket.id, {
            id: userId,
            username: sanitizedUsername,
            lastActivity: Date.now()
        });

        socket.userId = userId;
        socket.username = sanitizedUsername;

        // Send recent messages to new user
        socket.emit('messageHistory', messages.slice(-50));

        // Broadcast updated user list
        io.emit('userList', Array.from(activeUsers.values()));

        // Announce user joined
        const joinMessage = {
            id: uuidv4(),
            type: 'system',
            text: `${sanitizedUsername} joined the chat`,
            timestamp: Date.now()
        };
        messages.push(joinMessage);
        io.emit('message', joinMessage);
    });

    socket.on('message', (data) => {
        const user = activeUsers.get(socket.id);
        if (!user) return;

        const sanitizedText = sanitizeText(data.text);
        if (!sanitizedText || sanitizedText.length > 1000) {
            socket.emit('error', 'Invalid message');
            return;
        }

        const message = {
            id: uuidv4(),
            type: 'text',
            userId: user.id,
            username: user.username,
            text: sanitizedText,
            timestamp: Date.now()
        };

        messages.push(message);
        if (messages.length > 200) {
            messages.shift();
        }

        io.emit('message', message);

        // Update user activity
        user.lastActivity = Date.now();
    });

    socket.on('typing', (isTyping) => {
        const user = activeUsers.get(socket.id);
        if (!user) return;

        socket.broadcast.emit('userTyping', {
            userId: user.id,
            username: user.username,
            isTyping
        });
    });

    socket.on('disconnect', () => {
        const user = activeUsers.get(socket.id);
        if (user) {
            activeUsers.delete(socket.id);

            // Broadcast updated user list
            io.emit('userList', Array.from(activeUsers.values()));

            // Announce user left
            const leaveMessage = {
                id: uuidv4(),
                type: 'system',
                text: `${user.username} left the chat`,
                timestamp: Date.now()
            };
            messages.push(leaveMessage);
            io.emit('message', leaveMessage);
        }
        console.log('User disconnected:', socket.id);
    });
});

// Image upload endpoint
app.post('/upload-image', upload.single('image'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
    }

    const userId = req.body.userId;
    const user = Array.from(activeUsers.values()).find(u => u.id === userId);

    if (!user) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    // Convert image to base64
    const base64Image = req.file.buffer.toString('base64');
    const imageData = `data:${req.file.mimetype};base64,${base64Image}`;

    const message = {
        id: uuidv4(),
        type: 'image',
        userId: user.id,
        username: user.username,
        imageData: imageData,
        timestamp: Date.now()
    };

    messages.push(message);
    if (messages.length > 200) {
        messages.shift();
    }

    io.emit('message', message);
    res.json({ success: true });
});

// Clean up inactive users periodically
setInterval(() => {
    const now = Date.now();
    const timeout = 30000; // 30 seconds timeout

    for (const [socketId, user] of activeUsers.entries()) {
        if (now - user.lastActivity > timeout) {
            activeUsers.delete(socketId);
            io.emit('userList', Array.from(activeUsers.values()));
        }
    }
}, 10000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});