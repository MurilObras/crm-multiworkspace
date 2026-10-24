import { execFileSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { test, expect } from '@playwright/test';
import { loginComoAdmin, lerCreds } from './helpers/login-admin';

// PCM sintético curto; não contém voz de pessoa e nunca é enviado a contato real.
function wav(): Buffer {
  const pcm = Buffer.alloc(1600);
  for (let i = 0; i < 800; i++) pcm.writeInt16LE(Math.round(Math.sin(i * Math.PI / 10) * 1000), i * 2);
  const header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(8000, 24); header.writeUInt32LE(16000, 28); header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
test.describe.configure({ timeout: 240_000 });
test.beforeAll(() => { execFileSync('npx', ['tsx', 'scripts/seed-e2e-capacidades.ts'], { stdio: 'inherit' }); });
test('política de reenvio é configurável pela tela e persiste sem alterar o catálogo',async ({ page },info) => {
  const creds = await loginComoAdmin(page,lerCreds());
  const agent = creds.capacidades?.agent_id;
  if (!agent) throw new Error('Fixture ausente');
  const endpoint = `/api/v1/ai/agents/${agent}`;
  const initial = (await (await page.request.get(endpoint)).json()).data.config;
  expect((await page.request.patch(endpoint,{ data:{ config:{ temperature:0.73,max_tokens:777 } } })).ok()).toBe(true);
  const before = (await (await page.request.get(endpoint)).json()).data.config;
  try {
    await page.goto(`/app/ai/agents/${agent}`); await page.getByTestId('papel-conversa').click();
    const select = page.getByLabel('Política de reenvio de áudio, foto e vídeo');
    await expect(select).toBeEnabled();
    await select.selectOption('explicit_repeat');
    await page.getByRole('button',{ name:'Salvar política de reenvio',exact:true }).click();
    await expect(page.getByText('Política de reenvio salva e conferida.')).toBeVisible();
    await page.reload(); await page.getByTestId('papel-conversa').click();
    await expect(select).toHaveValue('explicit_repeat');
    const after = (await (await page.request.get(endpoint)).json()).data.config;
    expect(after.approved_media).toEqual(before?.approved_media);
    for (const [key,value] of Object.entries(before ?? {})) if (key !== 'media_replay_policy') expect(after[key]).toEqual(value);
    expect(after.temperature).toBe(0.73); expect(after.max_tokens).toBe(777);
    await mkdir('.superpowers/evidence/contextual-media-intent',{ recursive:true });
    await info.attach('politica-salva',{ body:await select.locator('..').screenshot({ path:'.superpowers/evidence/contextual-media-intent/politica.png' }),contentType:'image/png' });
  } finally {
    expect((await page.request.patch(endpoint,{ data:{ config:{ media_replay_policy:initial?.media_replay_policy ?? 'explicit_media_request',
      temperature:initial?.temperature ?? 0.4,max_tokens:initial?.max_tokens ?? 1024 } } })).ok()).toBe(true);
  }
});
test("catálogo grande continua editável e aceita a 20ª mídia pela tela", async ({ page }, info) => {
  const creds = await loginComoAdmin(page, lerCreds());
  const agent = creds.capacidades?.agent_id;
  if (!agent) throw new Error("Fixture mcp_agent ausente.");
  const endpoint = `/api/v1/ai/agents/${agent}/media`;
  const prefix = "E2E catálogo grande";
  const cleanup = async () => {
    const list = await page.request.get(endpoint);
    expect(list.ok()).toBe(true);
    for (const media of (await list.json()).data)
      if (media.title.startsWith(prefix))
        expect((await page.request.delete(endpoint, { data: { audio_id: media.id } })).ok()).toBe(
          true,
        );
  };
  await cleanup();
  const image = execFileSync("ffmpeg", [
    "-nostdin",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=blue:s=64x64",
    "-frames:v",
    "1",
    "-c:v",
    "png",
    "-f",
    "image2pipe",
    "pipe:1",
  ]);
  try {
    const initial = await page.request.get(endpoint);
    const count = (await initial.json()).data.length;
    for (let i = count; i < 19; i++) {
      const response = await page.request.post(endpoint, {
        multipart: {
          file: { name: "fixture.png", mimeType: "image/png", buffer: image },
          title: `${prefix} ${i}`,
          use_when: "Conteúdo sintético. ".repeat(49),
          send_when: "Pergunta sintética. ".repeat(49),
          required: "false",
        },
      });
      expect(response.status()).toBe(200);
    }
    await page.goto(`/app/ai/agents/${agent}`);
    await page.getByTestId("papel-conversa").click();
    const library = page.getByTestId("approved-audios");
    await expect(library.getByLabel("Arquivo")).toBeEnabled();
    await library
      .getByLabel("Arquivo")
      .setInputFiles({ name: "ultimo.png", mimeType: "image/png", buffer: image });
    await library.getByLabel("Título da mídia").fill(`${prefix} último`);
    await library
      .getByLabel("Conteúdo e finalidade da mídia")
      .fill("Demonstração sintética do último item permitido.");
    await library
      .getByLabel("Condição e exemplos de perguntas")
      .fill("Quando perguntar sobre o último exemplo.");
    await library.getByRole("button", { name: "Aprovar mídia para o agente" }).click();
    await expect(library.getByRole("status")).toContainText("Alteração salva");
    const toggle = library.getByRole("switch", { name: `Ativar mídia: ${prefix} último` });
    await expect(toggle).toBeChecked();
    await toggle.click();
    await expect(toggle).not.toBeChecked();
    await page.reload();
    await page.getByTestId("papel-conversa").click();
    await expect(toggle).not.toBeChecked();
    await toggle.click();
    await expect(toggle).toBeChecked();
    const item = library.locator("div.rounded-md").filter({ hasText: `${prefix} último` });
    await mkdir(".superpowers/evidence/midias-aprovadas", { recursive: true });
    await info.attach("catalogo-grande-salvo", {
      body: await item.screenshot({
        path: ".superpowers/evidence/midias-aprovadas/catalogo-grande.png",
      }),
      contentType: "image/png",
    });
    await item.getByRole("button", { name: "Remover mídia", exact: true }).click();
    await expect(library.getByText(`${prefix} último`, { exact: true })).toHaveCount(0);
  } finally {
    await cleanup();
  }
});

test('aprovar gravação → ouvir → recarregar → desativar → remover pela tela real', async ({ page }, info) => {
  const creds = await loginComoAdmin(page, lerCreds());
  const agent = creds.capacidades?.agent_id;
  if (!agent) throw new Error('Fixture mcp_agent ausente.');
  // Retry do Playwright pode encontrar a gravação deixada por um teste interrompido.
  const endpoint = `/api/v1/ai/agents/${agent}/media`;
  const previous = await page.request.get(endpoint);
  expect(previous.status()).toBe(200);
  const previousData = await previous.json();
  const stage = previousData.meta.stage_options[0];
  if (!stage) throw new Error('Fixture sem etapa de funil para vincular áudio.');
  for (const audio of previousData.data) {
    if (audio.title === 'E2E gravação aprovada') {
      expect((await page.request.delete(endpoint, { data: { audio_id: audio.id } })).status()).toBe(200);
    }
  }
  await page.goto(`/app/ai/agents/${agent}`);
  await page.getByTestId('papel-conversa').click();
  const library = page.getByTestId('approved-audios');
  await expect(library.getByRole('switch', { name: 'Envio obrigatório', exact: true })).toBeChecked();
  await expect(library.getByRole('heading', { name: 'Mídias aprovadas' })).toBeVisible();
  await expect(library.getByLabel('Arquivo')).toBeEnabled();
  await library.getByLabel('Arquivo').setInputFiles({ name: 'teste-isolado.wav', mimeType: 'audio/wav', buffer: wav() });
  await library.getByLabel('Título da mídia').fill('E2E gravação aprovada');
  await library.getByLabel('Conteúdo e finalidade da mídia').fill('Somente em testes isolados. Arquivo sintética de validação, sem mensagem comercial.');
  await library.getByLabel('Condição e exemplos de perguntas').fill('Quando perguntar como funciona o serviço, sem incluir preço.');
  await library.getByLabel('Onde esta mídia pode ser usada').selectOption('selected');
  await library.getByRole('checkbox', { name: `${stage.pipeline_name} › ${stage.name}`, exact: true }).check();
  const upload = page.waitForResponse(r => r.url().endsWith(`/agents/${agent}/media`) && r.request().method() === 'POST');
  await library.getByRole('button', { name: 'Aprovar mídia para o agente' }).click();
  expect((await upload).status()).toBe(200);
  const player = library.getByLabel('E2E gravação aprovada', { exact: true });
  await expect(player).toBeVisible();
  await player.evaluate(async el => {
    const audio = el as HTMLAudioElement;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Áudio não carregou.')), 15_000);
      audio.onloadeddata = () => { clearTimeout(timer); resolve(); };
      audio.onerror = () => { clearTimeout(timer); reject(new Error('Arquivo de áudio inválido.')); };
      audio.load();
    });
  });
  await mkdir('.superpowers/evidence/midias-aprovadas', { recursive: true });
  await info.attach('biblioteca-de-audios', { body: await library.screenshot({ path: '.superpowers/evidence/midias-aprovadas/audio.png' }), contentType: 'image/png' });
  await page.reload();
  await page.getByTestId('papel-conversa').click();
  await expect(library.getByText(`Etapas permitidas: ${stage.pipeline_name} › ${stage.name}`, { exact: true })).toBeVisible();
  await expect(library.getByText('Quando enviar esta mídia: Quando perguntar como funciona o serviço, sem incluir preço.', { exact: true })).toBeVisible();
  await library.getByRole('button', { name: 'Editar mídia' }).click();
  await library.getByLabel('Quando enviar esta mídia').first().selectOption('first_contact');
  await library.getByLabel('Onde esta mídia pode ser usada').first().selectOption('all');
  await expect(library.getByRole('switch', { name: 'Envio obrigatório', exact: true }).first()).toBeChecked();
  await library.getByRole('switch', { name: 'Envio obrigatório', exact: true }).first().click();
  await library.getByRole('button', { name: 'Salvar mídia' }).click();
  await expect(library.getByText('Envio opcional', { exact: true })).toBeVisible();
  await expect(library.getByText('Etapas permitidas: Todas as etapas', { exact: true })).toBeVisible();
  await page.reload(); await page.getByTestId('papel-conversa').click();
  await expect(library.getByText('Etapas permitidas: Todas as etapas', { exact: true })).toBeVisible();
  await expect(library.getByText('Envio opcional', { exact: true })).toBeVisible();
  await expect(library.getByText('Quando enviar esta mídia: No primeiro atendimento da conversa', { exact: true })).toBeVisible();
  await library.getByRole('button', { name: 'Editar mídia' }).click();
  await expect(library.getByLabel('Quando enviar esta mídia').first()).toHaveValue('first_contact');
  await library.getByRole('button', { name: 'Cancelar edição' }).click();
  const toggle = library.getByRole('switch', { name: 'Ativar mídia: E2E gravação aprovada' });
  await expect(toggle).toBeChecked(); await toggle.click(); await expect(toggle).not.toBeChecked();
  await page.reload(); await page.getByTestId('papel-conversa').click();
  await expect(toggle).not.toBeChecked();
  const item = library.locator('div.rounded-md').filter({ hasText: 'E2E gravação aprovada' });
  await item.getByRole('button', { name: 'Remover mídia' }).click();
  await expect(library.getByText('E2E gravação aprovada', { exact: true })).toHaveCount(0);
});

for (const kind of ['image','video'] as const) {
  test(`aprovar ${kind} → conferir prévia → persistir regra de reenvio → remover`, async ({ page },info) => {
    const creds = await loginComoAdmin(page,lerCreds());
    const agent = creds.capacidades?.agent_id;
    if (!agent) throw new Error('Fixture mcp_agent ausente.');
    const title = `E2E mídia ${kind}`;
    const endpoint = `/api/v1/ai/agents/${agent}/media`;
    const old = await page.request.get(endpoint); expect(old.ok()).toBe(true);
    for (const media of (await old.json()).data) if (media.title === title)
      expect((await page.request.delete(endpoint,{data:{audio_id:media.id}})).ok()).toBe(true);
    const args = ['-nostdin','-v','error','-f','lavfi','-i','color=c=blue:s=64x64:d=0.2','-an'];
    const buffer = execFileSync('ffmpeg',[...args,...(kind === 'image'
      ? ['-frames:v','1','-c:v','png','-f','image2pipe','pipe:1']
      : ['-c:v','libx264','-pix_fmt','yuv420p','-movflags','frag_keyframe+empty_moov','-f','mp4','pipe:1'])]);
    await page.goto(`/app/ai/agents/${agent}`); await page.getByTestId('papel-conversa').click();
    const library = page.getByTestId('approved-audios');
    await expect(library.getByRole('heading',{name:'Mídias aprovadas'})).toBeVisible();
    await library.getByLabel('Arquivo',{exact:true}).setInputFiles({name:kind === 'image' ? 'foto.png' : 'video.mp4',mimeType:kind === 'image' ? 'image/png' : 'video/mp4',buffer});
    await library.getByLabel('Título da mídia').fill(title);
    await library.getByLabel('Conteúdo e finalidade da mídia').fill('Demonstração sintética de configuração, sem dados reais.');
    await library.getByLabel('Condição e exemplos de perguntas').fill('Quando perguntar sobre esta demonstração sintética.');
    const upload = page.waitForResponse(r => r.url().endsWith(`/agents/${agent}/media`) && r.request().method() === 'POST');
    await library.getByRole('button',{name:'Aprovar mídia para o agente'}).click(); expect((await upload).ok()).toBe(true);
    const preview = kind === 'image' ? library.getByRole('img',{name:title}) : library.getByLabel(title,{exact:true});
    await expect(preview).toBeVisible();
    if (kind === 'image') await expect.poll(() => preview.evaluate(el => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    else await preview.evaluate(async el => {
      const video = el as HTMLVideoElement;
      await new Promise<void>((resolve,reject) => {
        const timer = setTimeout(()=>reject(new Error('Vídeo não decodificou.')),15_000);
        video.onloadeddata = ()=>{clearTimeout(timer);resolve();};
        video.onerror = ()=>{clearTimeout(timer);reject(new Error('Vídeo inválido.'));}; video.load();
      });
    });
    await library.locator('div.rounded-md').filter({hasText:title}).getByRole('button',{name:'Editar mídia',exact:true}).click();
    const repeat = library.getByRole('switch',{name:'Permitir reenvio a pedido explícito'}).first();
    await expect(repeat).toBeChecked(); await repeat.click();
    await library.getByRole('button',{name:'Salvar mídia',exact:true}).click();
    await page.reload(); await page.getByTestId('papel-conversa').click();
    const item = library.locator('div.rounded-md').filter({hasText:title});
    await item.getByRole('button',{name:'Editar mídia',exact:true}).click();
    await expect(library.getByRole('switch',{name:'Permitir reenvio a pedido explícito'}).first()).not.toBeChecked();
    await library.getByRole('button',{name:'Cancelar edição'}).click();
    // A captura após recarga também deve mostrar a prévia carregada, não o spinner.
    await expect.poll(() => preview.evaluate(el => el instanceof HTMLVideoElement ? el.readyState : (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(kind === 'video' ? 1 : 0);
    await mkdir('.superpowers/evidence/midias-aprovadas', { recursive: true });
    await info.attach(`midia-${kind}`,{body:await item.screenshot({path:`.superpowers/evidence/midias-aprovadas/${kind}.png`}),contentType:'image/png'});
    await item.getByRole('button',{name:'Remover mídia',exact:true}).click();
    await expect(library.getByText(title,{exact:true})).toHaveCount(0);
  });
}
