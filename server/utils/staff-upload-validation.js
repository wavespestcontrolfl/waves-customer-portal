/**
 * Server-side file validation for staff photo and company-document S3 uploads.
 * Never trusts client-supplied Content-Type or file extensions alone: inspects
 * magic bytes and assigns canonical extension + MIME type. Rejects HTML, SVG,
 * JavaScript, XML, and executable payloads to prevent stored XSS on S3 URLs.
 */

const ALLOWED_IMAGE_TYPES = {
  jpeg: { ext: 'jpg', contentType: 'image/jpeg' },
  png: { ext: 'png', contentType: 'image/png' },
  webp: { ext: 'webp', contentType: 'image/webp' },
  heic: { ext: 'heic', contentType: 'image/heic' },
};

const ALLOWED_DOC_CATEGORIES = new Set([
  'general', 'sop', 'onboarding', 'offer_letter', 'policy', 'training', 'safety',
  'hr', 'license', 'certification', 'tax', 'w4', 'i9', 'vehicle', 'other',
]);

const FORBIDDEN_DOC_EXTENSIONS = new Set([
  'html', 'htm', 'xhtml', 'svg', 'svgz', 'xml', 'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx',
  'php', 'phtml', 'sh', 'bash', 'bat', 'cmd', 'exe', 'dll', 'msi', 'jar', 'swf',
]);

const HEIF_BRANDS = new Set([
  'heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1', 'avif',
]);

function detectImageFromBytes(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return ALLOWED_IMAGE_TYPES.jpeg;
  if (
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47
    && buf[4] === 0x0D && buf[5] === 0x0A && buf[6] === 0x1A && buf[7] === 0x0A
  ) {
    return ALLOWED_IMAGE_TYPES.png;
  }
  if (buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') {
    return ALLOWED_IMAGE_TYPES.webp;
  }
  if (buf.subarray(4, 8).toString('ascii') === 'ftyp') {
    const brand = buf.subarray(8, 12).toString('ascii').toLowerCase();
    if (HEIF_BRANDS.has(brand)) return ALLOWED_IMAGE_TYPES.heic;
  }
  return null;
}

function fileExtension(originalname) {
  const base = String(originalname || '').trim();
  const idx = base.lastIndexOf('.');
  if (idx <= 0 || idx === base.length - 1) return '';
  return base.slice(idx + 1).toLowerCase();
}

function looksLikeActiveMarkup(buf) {
  const sample = buf.subarray(0, Math.min(buf.length, 4096)).toString('utf8').trimStart().toLowerCase();
  return /^(<!doctype\s+html|<html[\s>]|<svg[\s>]|<script[\s>]|<\?xml[\s>])/i.test(sample);
}

function validateStaffPhotoUpload(file) {
  if (!file || !Buffer.isBuffer(file.buffer) || file.buffer.length === 0) {
    return { error: 'No file provided' };
  }
  const ext = fileExtension(file.originalname);
  if (FORBIDDEN_DOC_EXTENSIONS.has(ext)) {
    return { error: 'Photo must be a JPEG, PNG, WebP, or HEIC image' };
  }
  const detected = detectImageFromBytes(file.buffer);
  if (!detected) {
    return { error: 'Photo must be a valid JPEG, PNG, WebP, or HEIC image' };
  }
  return detected;
}

function validateCompanyDocumentUpload(file) {
  if (!file || !Buffer.isBuffer(file.buffer) || file.buffer.length === 0) {
    return { error: 'No file provided' };
  }
  const rawName = String(file.originalname || '').trim();
  if (!rawName || rawName.length > 255) {
    return { error: 'File name must be 1 to 255 characters' };
  }
  const ext = fileExtension(rawName);
  if (!ext || FORBIDDEN_DOC_EXTENSIONS.has(ext)) {
    return { error: 'Unsupported or unsafe file type. Allowed: PDF, images, Word, Excel, CSV, or plain text.' };
  }
  const buf = file.buffer;
  const img = detectImageFromBytes(buf);
  if (img && ['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif'].includes(ext)) {
    return img;
  }
  if (ext === 'pdf' && buf.length >= 5 && buf.subarray(0, 5).toString('ascii') === '%PDF-') {
    return { ext: 'pdf', contentType: 'application/pdf' };
  }
  if ((ext === 'docx' || ext === 'xlsx') && buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4B && buf[2] === 0x03 && buf[3] === 0x04) {
    return {
      ext,
      contentType: ext === 'docx'
        ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    };
  }
  if ((ext === 'doc' || ext === 'xls') && buf.length >= 4 && buf[0] === 0xD0 && buf[1] === 0xCF && buf[2] === 0x11 && buf[3] === 0xE0) {
    return {
      ext,
      contentType: ext === 'doc' ? 'application/msword' : 'application/vnd.ms-excel',
    };
  }
  if ((ext === 'txt' || ext === 'csv') && !buf.includes(0) && !looksLikeActiveMarkup(buf)) {
    return { ext, contentType: ext === 'csv' ? 'text/csv; charset=utf-8' : 'text/plain; charset=utf-8' };
  }
  return { error: 'File contents do not match an allowed document type (PDF, image, Word, Excel, CSV, or plain text).' };
}

function safeDownloadFilename(name, fallback = 'document') {
  const cleaned = String(name || fallback)
    .replace(/[\r\n"\\]/g, '_')
    .replace(/[^\x20-\x7E]/g, '_')
    .trim();
  return cleaned.slice(0, 180) || fallback;
}

module.exports = {
  ALLOWED_DOC_CATEGORIES,
  validateStaffPhotoUpload,
  validateCompanyDocumentUpload,
  safeDownloadFilename,
};
