(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.RadarPhotoGeometry = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
    'use strict';

    function frame({ width, height, viewport, scale, x = 0, y = 0 }) {
        if (![width, height, viewport].every(value => Number.isFinite(value) && value > 0)) {
            throw new Error('Aguarde o carregamento da foto antes de pesquisar.');
        }
        const minimum = Math.max(viewport / width, viewport / height);
        const zoom = Math.max(minimum, Math.min(minimum * 6, Number.isFinite(scale) ? scale : minimum));
        const limitX = Math.max(0, (width * zoom - viewport) / 2);
        const limitY = Math.max(0, (height * zoom - viewport) / 2);
        return {
            scale: zoom, minimum, viewport,
            x: Math.max(-limitX, Math.min(limitX, Number.isFinite(x) ? x : 0)),
            y: Math.max(-limitY, Math.min(limitY, Number.isFinite(y) ? y : 0)),
        };
    }

    function crop(input, size = 400) {
        const state = frame(input);
        const ratio = size / state.viewport;
        const width = input.width * state.scale * ratio;
        const height = input.height * state.scale * ratio;
        return { x: size / 2 + state.x * ratio - width / 2,
            y: size / 2 + state.y * ratio - height / 2, width, height };
    }

    function resize(input, viewport) {
        const ratio = viewport / input.viewport;
        return frame({ ...input, viewport, scale: input.scale * ratio,
            x: input.x * ratio, y: input.y * ratio });
    }

    return { frame, crop, resize };
});
