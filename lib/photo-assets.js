const express = require('express');
const path = require('node:path');

module.exports = function photoAssets(app) {
    const root = path.join(__dirname, '..');
    for (const file of ['photo-geometry.js', 'face-landmarks.js']) {
        app.get('/' + file, (req, res) => res.sendFile(path.join(root, 'public', file)));
    }
    app.get('/models/face_landmarker.task', (req, res) =>
        res.sendFile(path.join(root, 'public/models/face_landmarker.task'), { maxAge: '1d' }));
    const vision = path.dirname(require.resolve('@mediapipe/tasks-vision'));
    app.get('/vision/vision_bundle.mjs', (req, res) => res.sendFile(path.join(vision, 'vision_bundle.mjs')));
    // Only the public WASM runtime is served; no project root or arbitrary node_modules.
    app.use('/vision/wasm', express.static(path.join(vision, 'wasm'), { index: false, dotfiles: 'deny' }));
};
