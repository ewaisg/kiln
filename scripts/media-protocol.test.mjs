import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMediaRequest } from '../src/lib/media-protocol.ts';
import { createServer } from 'node:http';
const endpoint = { id:'test', name:'Mock provider', kind:'openai', baseUrl:'https://example.com/v1', apiKey:'secret', model:'chat-model', apiVersion:'', direct:false };
test('transcription sends actual file bytes and independently selected model', async () => {
  const file = new File(['actual audio bytes'], 'sample.webm', {type:'audio/webm'});
  const {url, init} = buildMediaRequest(endpoint, 'transcription', {model:'transcriber'}, file);
  assert.equal(url,'https://example.com/v1/audio/transcriptions');
  assert.equal(init.body.get('model'),'transcriber');
  assert.equal(await init.body.get('file').text(),'actual audio bytes');
  assert.equal(init.headers.Authorization,'Bearer secret');
});
test('image edits use multipart references; generation does not issue fallback requests', () => {
  const ref = new File(['pixels'],'ref.png',{type:'image/png'});
  const edit=buildMediaRequest(endpoint,'image',{model:'image-model',input:'edit',size:'1024x1024'},ref);
  assert.equal(edit.url,'https://example.com/v1/images/edits');
  assert.equal(edit.init.body.get('image[]').name,'ref.png');
  const generate=buildMediaRequest(endpoint,'image',{model:'image-model',input:'generate'});
  assert.deepEqual(JSON.parse(generate.init.body),{model:'image-model',prompt:'generate',n:1});
});
test('speech bounds text; async video status/download/delete target submitted job', () => {
  const speech=buildMediaRequest(endpoint,'speech',{model:'tts-model',input:'a'.repeat(5000),voice:'voice-id'});
  assert.equal(JSON.parse(speech.init.body).input.length,4096);
  assert.equal(JSON.parse(speech.init.body).voice,'voice-id');
  const job={model:'',jobId:'video_abc'};
  assert.equal(buildMediaRequest(endpoint,'video-content',job).url,'https://example.com/v1/videos/video_abc/content');
  assert.equal(buildMediaRequest(endpoint,'video-status',job).init.method,'GET');
  assert.equal(buildMediaRequest(endpoint,'video-delete',job).init.method,'DELETE');
  assert.throws(()=>buildMediaRequest(endpoint,'video-status',{model:'',jobId:'../metadata'}));
});
test('unsupported protocols and missing inputs fail before network or paid call', () => {
  assert.throws(()=>buildMediaRequest({...endpoint,kind:'anthropic'},'speech',{model:'tts',input:'hi'}));
  assert.throws(()=>buildMediaRequest(endpoint,'transcription',{model:'asr'}));
  assert.throws(()=>buildMediaRequest(endpoint,'video-create',{model:'video',input:''}));
});
test('mock media server receives binary upload and speech adapter decodes real response body', async () => {
  const requests = [];
  const server = createServer(async (request,response) => {
    const chunks=[]; for await (const chunk of request) chunks.push(chunk);
    requests.push({path:request.url,body:Buffer.concat(chunks).toString(),contentType:request.headers['content-type']});
    if(request.url.endsWith('/audio/transcriptions')) { response.setHeader('content-type','application/json'); response.end(JSON.stringify({text:'mock transcript'})); }
    else { response.setHeader('content-type','audio/mpeg'); response.end(Buffer.from([73,68,51,1,2,3])); }
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const local={...endpoint,baseUrl:`http://127.0.0.1:${server.address().port}/v1`,direct:true};
    const upload=buildMediaRequest(local,'transcription',{model:'mock-asr'},new File(['encoded audio content'],'audio.webm',{type:'audio/webm'}));
    assert.equal((await (await fetch(upload.url,upload.init)).json()).text,'mock transcript');
    const speech=buildMediaRequest(local,'speech',{model:'mock-tts',input:'hello',voice:'mock-voice'});
    assert.equal((await (await fetch(speech.url,speech.init)).arrayBuffer()).byteLength,6);
    assert.match(requests[0].body,/encoded audio content/);
    assert.match(requests[0].contentType,/multipart\/form-data/);
    assert.equal(JSON.parse(requests[1].body).voice,'mock-voice');
  } finally { await new Promise(resolve=>server.close(resolve)); }
});
