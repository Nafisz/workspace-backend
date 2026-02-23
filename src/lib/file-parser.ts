import fs from 'fs/promises';
import path from 'path';
import pdfParse from 'pdf-parse';
import mammoth from 'mammoth';

export async function extractTextFromFile(filePath: string, fileName: string) {
  const ext = path.extname(fileName).toLowerCase();
  if (ext === '.pdf') {
    const buffer = await fs.readFile(filePath);
    const parsed = await pdfParse(buffer);
    return parsed.text;
  }
  if (ext === '.docx') {
    const buffer = await fs.readFile(filePath);
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  }
  if (ext === '.md' || ext === '.txt') {
    return await fs.readFile(filePath, 'utf-8');
  }
  throw new Error(`Unsupported file type: ${ext}`);
}
