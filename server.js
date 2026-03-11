const express = require('express');
const multer = require('multer');
const PizZip = require('pizzip');
const Docxtemplater = require('docxtemplater');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.get('/health', (req, res) => res.json({ ok: true }));

// Endpoint legado: recebe DOCX via multipart e converte para PDF
app.post('/convert', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Arquivo nao enviado' });
  console.log(`[convert] arquivo recebido: ${req.file.originalname}, tamanho: ${req.file.size} bytes`);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docx-'));
  const inputPath = path.join(tmpDir, 'input.docx');
  const outputPath = path.join(tmpDir, 'input.pdf');
  try {
    fs.writeFileSync(inputPath, req.file.buffer);
    fs.writeFileSync('/tmp/ultimo-recebido.docx', req.file.buffer);
    console.log('[convert] cópia salva em /tmp/ultimo-recebido.docx');
    const stdout = execSync('libreoffice --headless --norestore --nofirststartwizard -env:UserInstallation=file://' + tmpDir + '/lo-profile --convert-to pdf --outdir ' + tmpDir + ' ' + inputPath, { timeout: 60000, stdio: 'pipe' });
    console.log('[convert] libreoffice stdout:', stdout?.toString());
    const tmpFiles = fs.readdirSync(tmpDir);
    console.log('[convert] arquivos no tmpDir após conversão:', tmpFiles);
    if (!fs.existsSync(outputPath)) {
      return res.status(500).json({ error: 'Conversao falhou', stdout: stdout?.toString(), files: tmpFiles });
    }
    const pdfBuffer = fs.readFileSync(outputPath);
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': 'attachment; filename=' + (req.body.filename || 'contrato.pdf') });
    res.send(pdfBuffer);
  } catch (err) {
    console.error('[convert] ERRO:', err.message);
    console.error('[convert] stderr:', err.stderr?.toString());
    console.error('[convert] stdout:', err.stdout?.toString());
    fs.rmSync(tmpDir, { recursive: true, force: true });
    res.status(500).json({ error: 'Conversao falhou', detail: err.message, stderr: err.stderr?.toString() });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// Endpoint principal: recebe JSON com dados do contrato, baixa template, gera DOCX e converte para PDF
app.post('/generate-pdf', express.json({ limit: '2mb' }), async (req, res) => {
  const { data, safeName } = req.body;
  if (!data) return res.status(400).json({ error: 'data é obrigatório' });

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    return res.status(500).json({ error: 'SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY não configurados' });
  }

  console.log('[generate-pdf] Baixando template do Storage...');
  let templateBuffer;
  try {
    const templateRes = await fetch(`${supabaseUrl}/storage/v1/object/contracts/contrato_template.docx`, {
      headers: { Authorization: `Bearer ${serviceKey}` },
    });
    if (!templateRes.ok) {
      const errText = await templateRes.text();
      console.error('[generate-pdf] Erro ao baixar template:', templateRes.status, errText);
      return res.status(500).json({ error: 'Falha ao baixar template do Storage', detail: errText });
    }
    templateBuffer = Buffer.from(await templateRes.arrayBuffer());
    console.log('[generate-pdf] Template baixado, tamanho:', templateBuffer.length, 'bytes');
  } catch (err) {
    console.error('[generate-pdf] Erro de rede ao baixar template:', err.message);
    return res.status(500).json({ error: 'Erro de rede ao baixar template', detail: err.message });
  }

  console.log('[generate-pdf] Aplicando docxtemplater...');
  let filledDocx;
  try {
    const zip = new PizZip(templateBuffer);
    const doc = new Docxtemplater(zip, {
      delimiters: { start: '{{', end: '}}' },
      paragraphLoop: true,
      linebreaks: true,
      nullGetter: () => '',
    });
    doc.render(data);
    filledDocx = doc.getZip().generate({ type: 'nodebuffer' });
    console.log('[generate-pdf] DOCX gerado, tamanho:', filledDocx.length, 'bytes');
  } catch (err) {
    console.error('[generate-pdf] Erro no docxtemplater:', err.message, err.properties);
    return res.status(500).json({ error: 'Erro ao preencher template', detail: err.message, properties: err.properties });
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'genpdf-'));
  const inputPath = path.join(tmpDir, 'input.docx');
  const outputPath = path.join(tmpDir, 'input.pdf');
  try {
    fs.writeFileSync(inputPath, filledDocx);
    fs.writeFileSync('/tmp/ultimo-gerado.docx', filledDocx);
    console.log('[generate-pdf] cópia salva em /tmp/ultimo-gerado.docx');

    const stdout = execSync(
      'libreoffice --headless --norestore --nofirststartwizard -env:UserInstallation=file://' + tmpDir + '/lo-profile --convert-to pdf --outdir ' + tmpDir + ' ' + inputPath,
      { timeout: 60000, stdio: 'pipe' }
    );
    console.log('[generate-pdf] libreoffice stdout:', stdout?.toString());

    const tmpFiles = fs.readdirSync(tmpDir);
    console.log('[generate-pdf] arquivos no tmpDir:', tmpFiles);

    if (!fs.existsSync(outputPath)) {
      return res.status(500).json({ error: 'Conversao falhou', stdout: stdout?.toString(), files: tmpFiles });
    }

    const pdfBuffer = fs.readFileSync(outputPath);
    const filename = `contrato_${safeName || 'contrato'}.pdf`;
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${filename}"` });
    res.send(pdfBuffer);
  } catch (err) {
    console.error('[generate-pdf] ERRO LibreOffice:', err.message);
    console.error('[generate-pdf] stderr:', err.stderr?.toString());
    console.error('[generate-pdf] stdout:', err.stdout?.toString());
    res.status(500).json({ error: 'Conversao falhou', detail: err.message, stderr: err.stderr?.toString() });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

app.listen(3333, () => console.log('docx-to-pdf porta 3333'));
