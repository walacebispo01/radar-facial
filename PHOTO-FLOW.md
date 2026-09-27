# Correção do enquadramento e pontos faciais

Esta entrega altera o fluxo da foto. Administração de criadores e comissões em rede continuam no plano, fora deste pacote de alterações.

## Comportamento

O navegador aguarda o carregamento da imagem, calcula o enquadramento pelas dimensões reais do círculo e limita o arraste para não deixar regiões vazias. O enquadramento é preservado ao redimensionar a tela.

Ao procurar, congela um JPEG de 400 × 400. O detector MediaPipe analisa esse JPEG no navegador. A animação usa os pontos detectados de olhos, sobrancelhas, boca, nariz e contorno. Ausência de rosto, múltiplos rostos e falha de carregamento têm tratamento próprio. Navegar de volta cancela resultados atrasados.

A prévia mostra o mesmo JPEG sem desfoque e sem uma porcentagem fictícia de correspondência. O usuário pode ajustar o enquadramento ou iniciar a busca por um crédito. O upload contém exatamente os mesmos bytes usados na detecção e na prévia. Falhas de conexão reutilizam a chave idempotente da tentativa; a pesquisa real continua sendo processada pelo backend existente.

## Arquivos

- `public/photo-geometry.js`: geometria do recorte e preservação ao redimensionar.
- `public/face-landmarks.js`: carregamento sob demanda do detector e do modelo.
- `public/models/`: modelo versionado e origem/SHA-256.
- `lib/photo-assets.js`: rotas explícitas dos recursos públicos, sem expor a raiz do projeto.
- `index.html`: interação, captura única, desenho do overlay, prévia e envio.
- `test/photo-geometry.test.js`: testes comportamentais da geometria.
- `scripts/test-photo-browser.js`: teste do detector real, interface e comparação entre JPEG da prévia e upload.

## Instalação e publicação

1. Instalar com `npm ci` no ambiente de teste, mantendo o modelo incluído no pacote.
2. Executar `npm test` e `npm run check`.
3. Repetir os testes do navegador e a validação em aparelhos reais antes da publicação.
4. A publicação usa `npm ci --omit=dev` e o comando de início já existente. Não há migração SQL nesta etapa.

As variáveis de autenticação, FaceCheck, Mercado Pago e PostgreSQL continuam sendo as já usadas pelo projeto. Não incluir seus valores em arquivos versionados.

O modelo tem aproximadamente 3,8 MB, além do runtime WASM carregado na primeira detecção. Erro/timeout de carregamento permite nova tentativa. A inferência de imagem única é síncrona; seu tempo em aparelhos mais lentos precisa ser medido na validação móvel. Não há promessa de encontrar um perfil só porque o detector encontrou um rosto.

## Teste de navegador

Requer Google Chrome instalado e dependências de desenvolvimento. O teste usa uma sessão fictícia e intercepta a busca paga: não faz login Google nem gasta créditos FaceCheck. O detector e o modelo são reais. O teste bloqueia recursos externos, incluindo a fonte de ícones; por isso capturas de teste podem aparecer sem esses ícones.

No PowerShell:

```powershell
$env:PHOTO_TEST_IMAGE = 'C:\caminho\para\foto-frontal-de-teste.jpg'
$env:BROWSER_TEST_OUTPUT = 'C:\caminho\para\resultados-do-teste'
npm run test:browser
```

Na validação desta entrega foi usada a imagem pública de teste do MediaPipe em `https://storage.googleapis.com/mediapipe-assets/portrait.jpg`. Ela não é incluída neste pacote.

Verificações: carregamento, zoom/arraste, preservação entre larguras, 132 pontos na imagem de teste, prévia sem desfoque, igualdade dos bytes enviados, ausência de rosto, falha do modelo e cancelamento de detecção pendente.

## Limites da validação

Os testes automatizados usam Chrome desktop e viewport móvel. Eles não substituem Safari/iPhone, Chrome/Android, captura pela câmera nativa, orientação EXIF e gestos de pinça em aparelhos reais. O resultado efetivo de pesquisa FaceCheck não foi consultado nesta etapa.

O pacote MediaPipe declara processamento de imagens no dispositivo e coleta própria de métricas de desempenho/uso; consultar a seção Privacy Notice da versão instalada. Não confundir hospedagem local do modelo com uma garantia de ausência de telemetria da biblioteca.
