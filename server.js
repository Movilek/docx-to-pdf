const express = require('express');
const multer = require('multer');
const PizZip = require('pizzip');
const Docxtemplater = require('docxtemplater');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const app = express();
app.use(express.json({ limit: '2mb' }));
const upload = multer({ storage: multer.memoryStorage() });

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function fmtBRL(v) {
  return Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}
function fmtDate(d) {
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}/${mm}/${d.getFullYear()}`;
}
function fmtMonthYear(d) {
  return `${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
}
function fmtDateExtenso(d) {
  const meses = ['janeiro','fevereiro','março','abril','maio','junho','julho','agosto','setembro','outubro','novembro','dezembro'];
  return `${d.getDate()} de ${meses[d.getMonth()]} de ${d.getFullYear()}`;
}

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
    const stdout = execSync(
      'libreoffice --headless --norestore --nofirststartwizard -env:UserInstallation=file://' + tmpDir + '/lo-profile --convert-to pdf --outdir ' + tmpDir + ' ' + inputPath,
      { timeout: 60000, stdio: 'pipe' }
    );
    console.log('[convert] stdout:', stdout?.toString());
    const tmpFiles = fs.readdirSync(tmpDir);
    if (!fs.existsSync(outputPath)) {
      return res.status(500).json({ error: 'Conversao falhou', stdout: stdout?.toString(), files: tmpFiles });
    }
    const pdfBuffer = fs.readFileSync(outputPath);
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': 'attachment; filename=contrato.pdf' });
    res.send(pdfBuffer);
  } catch (err) {
    console.error('[convert] ERRO:', err.message);
    console.error('[convert] stderr:', err.stderr?.toString());
    res.status(500).json({ error: 'Conversao falhou', detail: err.message, stderr: err.stderr?.toString() });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// Endpoint principal: recebe company_id + token, busca dados no Supabase, gera DOCX e converte para PDF
app.post('/generate-pdf', async (req, res) => {
  console.log('[generate-pdf] body:', JSON.stringify(req.body));
  const { company_id, token } = req.body || {};

  if (!company_id) return res.status(400).json({ error: 'company_id é obrigatório' });
  if (!token)      return res.status(400).json({ error: 'token é obrigatório' });
  if (!SUPABASE_URL || !SERVICE_KEY) {
    return res.status(500).json({ error: 'SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY não configurados' });
  }

  // 1. Busca dados do contrato no Supabase usando o token do usuário (RLS aplicado)
  console.log('[generate-pdf] Buscando contrato:', company_id);
  let contract;
  try {
    const dbRes = await fetch(
      `${SUPABASE_URL}/rest/v1/service_contracts?id=eq.${company_id}&select=razao_social,cnpj_cpf,endereco,representante_legal,cpf_representante,valor_honorario,regime_tributario,qtd_empregados,qtd_pro_labore,faturamento_limite,qtd_nfe_mes`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          apikey: SERVICE_KEY,
          Accept: 'application/json',
        },
      }
    );
    if (!dbRes.ok) {
      const t = await dbRes.text();
      console.error('[generate-pdf] Erro DB:', dbRes.status, t);
      return res.status(500).json({ error: 'Erro ao buscar contrato', detail: t });
    }
    const rows = await dbRes.json();
    if (!rows.length) return res.status(404).json({ error: 'Contrato não encontrado' });
    contract = rows[0];
    console.log('[generate-pdf] Contrato:', contract.razao_social);
  } catch (err) {
    console.error('[generate-pdf] Erro de rede DB:', err.message);
    return res.status(500).json({ error: 'Erro de rede ao buscar contrato', detail: err.message });
  }

  // 2. Baixa template do Storage
  console.log('[generate-pdf] Baixando template...');
  let templateBuffer;
  try {
    const tRes = await fetch(`${SUPABASE_URL}/storage/v1/object/contracts/contrato_template.docx`, {
      headers: { Authorization: `Bearer ${SERVICE_KEY}` },
    });
    if (!tRes.ok) {
      const t = await tRes.text();
      console.error('[generate-pdf] Erro template:', tRes.status, t);
      return res.status(500).json({ error: 'Falha ao baixar template', detail: t });
    }
    templateBuffer = Buffer.from(await tRes.arrayBuffer());
    console.log('[generate-pdf] Template:', templateBuffer.length, 'bytes');
  } catch (err) {
    console.error('[generate-pdf] Erro de rede template:', err.message);
    return res.status(500).json({ error: 'Erro de rede ao baixar template', detail: err.message });
  }

  // 3. Preenche template com docxtemplater
  const now = new Date();
  const data = {
    NOME_CLIENTE:        contract.razao_social || '',
    ENDERECO_CLIENTE:    contract.endereco || '',
    CNPJ_CLIENTE:        contract.cnpj_cpf || '',
    REPRESENTANTE_LEGAL: contract.representante_legal || '',
    CPF_REPRESENTANTE:   contract.cpf_representante || '',
    VALOR_HONORARIOS:    fmtBRL(contract.valor_honorario),
    DATA_INICIO:         fmtDate(now),
    SISTEMA_TRIBUTACAO:  contract.regime_tributario || '',
    QTD_EMPREGADOS:      String(contract.qtd_empregados || ''),
    QTD_PRO_LABORE:      String(contract.qtd_pro_labore || ''),
    FATURAMENTO:         String(contract.faturamento_limite || ''),
    QTD_NFE:             String(contract.qtd_nfe_mes ?? ''),
    QTD_LANCAMENTOS:     '0',
    COMPETENCIA_INICIO:  fmtMonthYear(now),
    DATA_ASSINATURA:     fmtDateExtenso(now),
  };

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
    console.log('[generate-pdf] DOCX preenchido:', filledDocx.length, 'bytes');
    fs.writeFileSync('/tmp/ultimo-gerado.docx', filledDocx);
  } catch (err) {
    console.error('[generate-pdf] Erro docxtemplater:', err.message, JSON.stringify(err.properties));
    return res.status(500).json({ error: 'Erro ao preencher template', detail: err.message, properties: err.properties });
  }

  // 4. Converte com LibreOffice
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'genpdf-'));
  const inputPath = path.join(tmpDir, 'input.docx');
  const outputPath = path.join(tmpDir, 'input.pdf');
  try {
    fs.writeFileSync(inputPath, filledDocx);
    const stdout = execSync(
      'libreoffice --headless --norestore --nofirststartwizard -env:UserInstallation=file://' + tmpDir + '/lo-profile --convert-to pdf --outdir ' + tmpDir + ' ' + inputPath,
      { timeout: 60000, stdio: 'pipe' }
    );
    console.log('[generate-pdf] libreoffice stdout:', stdout?.toString());
    const tmpFiles = fs.readdirSync(tmpDir);
    console.log('[generate-pdf] tmpDir files:', tmpFiles);
    if (!fs.existsSync(outputPath)) {
      return res.status(500).json({ error: 'Conversao falhou', stdout: stdout?.toString(), files: tmpFiles });
    }
    const pdfBuffer = fs.readFileSync(outputPath);
    const safeName = (contract.razao_social || 'contrato').replace(/[^a-zA-Z0-9_\-]/g, '_');
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="contrato_${safeName}.pdf"` });
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
