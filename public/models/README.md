# Modelo de pontos faciais

Face Landmarker oficial, float16, versão 1. Processamento local no navegador.

- Origem: https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task
- SHA-256: `64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff`
- Biblioteca: `@mediapipe/tasks-vision`, versão fixada no package-lock.json, Apache-2.0.
- Documentação do modelo: https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker

Os arquivos JS, WASM e modelo são servidos pelo próprio site. A detecção de pontos não envia a foto a um serviço de detecção externo. A pesquisa real continua sendo enviada ao backend/FaceCheck quando solicitada pelo usuário.
