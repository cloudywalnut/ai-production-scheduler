import fs from "fs";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";

async function chunkPDF(filePath, pagesPerChunk = 30) {
  const data = new Uint8Array(fs.readFileSync(filePath));

  const pdf = await pdfjsLib.getDocument({ data }).promise;
  const totalPages = pdf.numPages;

  const chunks = [];

  for (let i = 1; i <= totalPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();

    const text = content.items.map(item => item.str).join(" ");
    
    chunks.push({
      page: i,
      text
    });
  }

  return chunks;
}

const chunkArray = await chunkPDF("pdfs/KLAWANG_DRAFT_2.0.pdf");
console.log(chunkArray);