(function () {
    'use strict';
    let detectorPromise;
    let contours;

    async function detector() {
        if (!detectorPromise) {
            detectorPromise = (async () => {
                const { FaceLandmarker, FilesetResolver } = await import('/vision/vision_bundle.mjs');
                const files = await FilesetResolver.forVisionTasks('/vision/wasm');
                const task = await FaceLandmarker.createFromOptions(files, {
                    baseOptions: { modelAssetPath: '/models/face_landmarker.task', delegate: 'CPU' },
                    runningMode: 'IMAGE', numFaces: 2,
                    minFaceDetectionConfidence: 0.5, minFacePresenceConfidence: 0.5,
                });
                contours = FaceLandmarker.FACE_LANDMARKS_CONTOURS;
                return task;
            })().catch(error => { detectorPromise = null; throw error; });
        }
        return detectorPromise;
    }

    async function detect(dataUrl) {
        // Decode the same JPEG used in the preview and upload, never the original photo.
        const image = new Image();
        image.src = dataUrl;
        await image.decode();
        let timer;
        try {
            const task = await Promise.race([
                detector(),
                new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('MODEL_TIMEOUT')), 30000); }),
            ]);
            const faces = task.detect(image).faceLandmarks;
            if (faces.length === 0) throw new Error('NO_FACE');
            if (faces.length > 1) throw new Error('MULTIPLE_FACES');
            const connections = contours.map(({ start, end }) => [start, end]);
            const indices = new Set(connections.flat());
            // Nose bridge/tip complete the contour drawing using detected coordinates.
            [1, 4, 6, 168].forEach(id => indices.add(id));
            connections.push([168, 6], [6, 4], [4, 1]);
            const points = [...indices].map(id => ({ id, x: faces[0][id].x, y: faces[0][id].y }));
            if (points.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y))) throw new Error('INVALID_POINTS');
            return { points, connections };
        } finally { clearTimeout(timer); }
    }

    window.RadarFaceLandmarks = { detect };
})();
