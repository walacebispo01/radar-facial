const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
const { createCreatorStore } = require('../lib/creator-store');
const { createCreatorPortalStore, videoLink } = require('../lib/creator-portal-store');
const { createStore } = require('../lib/postgres-store');
const { createSessionStore } = require('../lib/session-store');
const { createProgramSecurity, totp } = require('../lib/program-security');

test('links públicos de criativos rejeitam protocolo perigoso e endereços privados sem buscar conteúdo remoto', () => {
    for (const url of ['javascript:alert(1)', 'http://youtube.com/x', 'https://127.0.0.1/x', 'https://[::1]/x', 'https://x.local/x', 'https://a:b@youtube.com/x']) assert.throws(() => videoLink(url));
    for (const [url, platform] of [['https://youtu.be/abcdefghijk','YouTube'], ['https://www.tiktok.com/@x/video/123','TikTok'], ['https://instagram.com/reel/abc','Instagram'], ['https://fb.watch/abc/','Facebook'], ['https://vimeo.com/123','Outras']]) assert.equal(videoLink(url).plataforma, platform);
});

test('convite Google, aprovação atômica, simulação, limite concorrente, moderação, isolamento e suspensão', async t => {
    const db = new PGlite(); t.after(() => db.close());
    for (const file of ['schema-proposto.sql','migrations/001-sessoes.sql','migrations/002-criadores.sql','migrations/003-comissoes-rede.sql','migrations/004-simulacao-historico.sql','migrations/005-convites-provas.sql']) await db.exec(fs.readFileSync(path.join(__dirname,'../sql',file),'utf8'));
    let tail = Promise.resolve(); const pool = { async connect() { const prior = tail; let release; tail = new Promise(r => { release = r; }); await prior; return { query: (q,p) => db.query(q,p), release }; }, async query(q,p) { const c = await pool.connect(); try { return await c.query(q,p); } finally { c.release(); } } };
    const adminEmail = 'osasukedoinsta@gmail.com', otherAdmin = 'unapproved@example.test';
    const creators = createCreatorStore(pool), portal = createCreatorPortalStore(pool, creators);
    const root = await creators.createCreator({nome:'Raiz',email:'root@example.test',demo_enabled:true},adminEmail);
    const sibling = await creators.createCreator({nome:'Outro ramo',email:'sibling@example.test',demo_enabled:true},adminEmail);
    const links = await portal.links(root.email), token = new URL(links.invitation,'https://radarfacial.com.br').searchParams.get('token');
    assert.equal((await portal.invite(token)).id,root.id);
    await assert.rejects(portal.invite('garbage'), /Convite/);
    await db.query('INSERT INTO public.usuarios(email) VALUES($1),($2)', ['candidate@example.test','rollback@example.test']);
    const application = await portal.apply('candidate@example.test',{token,nome:'Candidato'});
    assert.equal((await portal.apply('candidate@example.test',{token,nome:'Tentativa de alterar nome'})).id,application.id);
    assert.equal(await creators.me('candidate@example.test'),null);
    await assert.rejects(portal.ownVideos('candidate@example.test'), /não autorizado/);
    const approved = await portal.decideApplication(application.id,true,adminEmail);
    assert.equal((await portal.decideApplication(application.id,true,adminEmail)).criador_id,approved.criador_id);
    const candidate = await creators.me('candidate@example.test'); assert.equal(candidate.parent_id,root.id); assert.equal(candidate.demo_enabled,true);
    assert.equal((await db.query('SELECT usuario_email FROM public.simulacao_criadores WHERE usuario_email=$1',[candidate.email])).rows.length,1);
    assert.equal(await creators.canAccessNetwork(candidate.id,root.id),false); assert.equal(await creators.canAccessNetwork(root.id,candidate.id),true);
    const rollback = await portal.apply('rollback@example.test',{token,nome:'Rollback'});
    const original = creators.createCreator; creators.createCreator = async (...args) => { await original(...args); throw new Error('forced failure'); };
    await assert.rejects(portal.decideApplication(rollback.id,true,adminEmail), /forced failure/); creators.createCreator = original;
    assert.equal(await creators.me('rollback@example.test'),null); assert.equal((await portal.application('rollback@example.test')).status,'pendente');
    const created = await Promise.allSettled(Array.from({length:6},(_,i)=>portal.saveVideo(candidate.email,{titulo:'Vídeo '+i,url:'https://www.youtube.com/watch?v=abcdefghijk&x='+i})));
    assert.equal(created.filter(r=>r.status==='fulfilled').length,5); assert.equal((await portal.ownVideos(candidate.email)).length,5);
    let video = created.find(r=>r.status==='fulfilled').value;
    assert.equal((await portal.publicVideos()).total,0);
    await assert.rejects(portal.saveVideo(sibling.email,{id:video.id,titulo:'Roubo',url:video.url}), /não encontrado/);
    video = await portal.moderate(video.id,{status:'aprovado',destaque:true,versao:video.versao},adminEmail);
    assert.equal((await portal.publicVideos({highlights:true})).total,1);
    await assert.rejects(portal.moderate(video.id,{status:'aprovado',destaque:true,versao:video.versao-1},adminEmail), /alterado/);
    video = await portal.saveVideo(candidate.email,{id:video.id,titulo:'Link novo',url:'https://instagram.com/reel/novo/'});
    assert.equal(video.status,'pendente'); assert.equal((await portal.publicVideos()).total,0);
    video = await portal.moderate(video.id,{status:'aprovado',destaque:true,versao:video.versao},adminEmail);
    const second = await portal.saveVideo(root.email,{titulo:'Segundo',url:'https://vimeo.com/123'});
    await portal.moderate(second.id,{status:'aprovado',destaque:true,versao:second.versao},adminEmail);
    await portal.reorder([second.id,video.id],adminEmail); assert.equal((await portal.publicVideos({highlights:true})).items[0].id,second.id);
    await assert.rejects(portal.reorder([video.id],adminEmail), /mudou/);
    await creators.updateCreator(candidate.id,{status:'suspenso',motivo:'Suspensão de teste'},adminEmail);
    assert.equal((await portal.publicVideos()).total,1); await assert.rejects(portal.links(candidate.email), /não autorizado/); await assert.rejects(creators.assertLegacySimulationAccess(candidate.email), /suspenso/);
    const candidateToken = (await db.query('SELECT token FROM public.criadores_convites WHERE criador_id=$1',[candidate.id])).rows[0]?.token;
    if(candidateToken) await assert.rejects(portal.invite(candidateToken), /indisponível/);

    const oldAdmins = process.env.ADMIN_EMAILS; process.env.ADMIN_EMAILS = adminEmail+','+otherAdmin; t.after(()=>{if(oldAdmins===undefined)delete process.env.ADMIN_EMAILS;else process.env.ADMIN_EMAILS=oldAdmins});
    const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'; const security = createProgramSecurity(pool,{secrets:{[adminEmail]:secret}});
    const app = require('../server').createApp({store:createStore(pool),sessions:createSessionStore(pool),creatorStore:creators,creatorPortal:portal,programSecurity:security,commissionProgram:{},payment:{},appOrigin:'https://radarfacial.com.br',verifyGoogle:async credential=>({email:credential,sub:credential})});
    const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>new Promise(r=>server.close(r)));const base='http://127.0.0.1:'+server.address().port;
    async function req(route,session,body,headers={}){const r=await fetch(base+route,{method:body===undefined?'GET':'POST',headers:{origin:'https://radarfacial.com.br','x-radar-request':'1','content-type':'application/json',...(session?{cookie:session.cookie,'x-csrf-token':session.csrfToken}:{}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});return{status:r.status,data:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]}}
    async function login(email){const r=await req('/api/login-google',null,{credential:email});assert.equal(r.status,200);return{...r.data,cookie:r.cookie}}
    const admin=await login(adminEmail),other=await login(otherAdmin),user=await login(root.email);
    assert.equal((await req('/api/provas-sociais')).status,200);
    assert.equal((await req('/api/criadores/videos')).status,401);
    assert.equal((await req('/api/criadores/admin/videos',user)).status,403);
    assert.equal((await req('/api/criadores/admin/videos',other)).status,403);
    assert.equal((await req('/api/criadores/admin/videos',admin)).status,403);
    assert.equal((await req('/api/programa/admin/verificar',admin,{code:totp(secret,Math.floor(Date.now()/30000))})).status,200);
    assert.equal((await req('/api/criadores/admin/videos',admin)).status,200);
    assert.equal((await req('/api/criadores/admin/videos/'+second.id,admin,{status:'aprovado',destaque:true,versao:2},{'x-csrf-token':''})).status,403);
    assert.equal((await req('/api/criadores/videos',user,{titulo:'Teste',url:'https://vimeo.com/456',criador_id:sibling.id})).status,201);
    assert.equal((await portal.ownVideos(sibling.email)).length,0);
});
