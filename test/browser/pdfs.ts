/**
 * A PDF of `pages` pages, letter-sized unless `size` says otherwise, each saying "Page n" over a blue band. With `script`, that
 * script is in every place a PDF reader runs one from: the document's opening action, its named
 * scripts, each page's opening action, a link on the first page, and a button's actions; and with
 * `uri`, the link and the button also go to that address. Nothing of it is ever run by the app.
 */
export function pdf({ pages = 1, script, uri, size = [612, 792] }: { pages?: number; script?: string; uri?: string; size?: [number, number] } = {}): Buffer {
  const literal = (text: string) => `(${text.replace(/[\\()]/g, (c) => `\\${c}`)})`;
  const js = script ? `<< /S /JavaScript /JS ${literal(script)} >>` : "";
  const first = 4;
  const objects: string[] = [
    `<< /Type /Catalog /Pages 2 0 R${script ? ` /OpenAction ${js} /Names << /JavaScript << /Names [(run) ${js}] >> >> /AcroForm << /Fields [${first + 2 * pages + 1} 0 R] >>` : ""} >>`,
    `<< /Type /Pages /Kids [${Array.from({ length: pages }, (_, i) => `${first + 2 * i} 0 R`).join(" ")}] /Count ${pages} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  for (let i = 0; i < pages; i++) {
    const words = `BT /F1 36 Tf 72 700 Td (Page ${i + 1}) Tj ET 0.36 0.36 0.84 rg 72 200 468 300 re f`;
    const annots = script && i === 0 ? ` /Annots [${first + 2 * pages} 0 R ${first + 2 * pages + 1} 0 R] /AA << /O ${js} >>` : "";
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${size.join(" ")}] /Contents ${first + 2 * i + 1} 0 R /Resources << /Font << /F1 3 0 R >> >>${annots} >>`, `<< /Length ${words.length} >>\nstream\n${words}\nendstream`);
  }
  if (script) {
    const go = uri ? `<< /S /URI /URI ${literal(uri)} /Next ${js} >>` : js;
    objects.push(`<< /Type /Annot /Subtype /Link /Rect [72 600 400 650] /Border [0 0 0] /A ${go} >>`);
    objects.push(`<< /Type /Annot /Subtype /Widget /FT /Btn /Ff 65536 /T (go) /Rect [72 540 300 580] /P ${first} 0 R /A ${go} /AA << /E ${js} /D ${js} /PO ${js} >> >>`);
  }
  return pdfOf(objects);
}

/** A PDF of `objects`, numbered from 1, the first of them its catalog: for one made wrong on purpose. */
export function pdfOf(objects: string[]): Buffer {
  let out = "%PDF-1.7\n";
  const at = objects.map((object, i) => {
    const offset = out.length;
    out += `${i + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${at.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}
