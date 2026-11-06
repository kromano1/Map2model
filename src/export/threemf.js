// 3MF writer: one mesh object per part, grouped under a single parent object
// so slicers (Bambu Studio, OrcaSlicer, PrusaSlicer, Cura) import it as one
// multi-part model and let you assign a filament per part.

import { zipSync, strToU8 } from 'fflate';

const esc = (s) => String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));

/**
 * @param {{name:string,color:string,mesh:import('../mesh/meshbuf.js').MeshBuf}[]} parts
 * @param {{title?:string, attribution?:string}} meta
 */
export function write3MF(parts, meta = {}) {
  const used = parts.filter((p) => !p.mesh.empty);
  const out = [];
  out.push('<?xml version="1.0" encoding="UTF-8"?>');
  out.push('<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">');
  out.push(`<metadata name="Title">${esc(meta.title ?? 'TopoForge model')}</metadata>`);
  out.push('<metadata name="Application">TopoForge</metadata>');
  if (meta.attribution) out.push(`<metadata name="Copyright">${esc(meta.attribution)}</metadata>`);
  out.push('<resources>');
  out.push('<basematerials id="1">');
  for (const p of used) out.push(`<base name="${esc(p.name)}" displaycolor="${hexRGBA(p.color)}"/>`);
  out.push('</basematerials>');

  used.forEach((p, k) => {
    const { pos, idx } = p.mesh;
    out.push(`<object id="${k + 2}" name="${esc(p.name)}" type="model" pid="1" pindex="${k}"><mesh><vertices>`);
    const v = [];
    for (let i = 0; i < pos.length; i += 3) v.push(`<vertex x="${f(pos[i])}" y="${f(pos[i + 1])}" z="${f(pos[i + 2])}"/>`);
    out.push(v.join(''));
    out.push('</vertices><triangles>');
    const t = [];
    for (let i = 0; i < idx.length; i += 3) t.push(`<triangle v1="${idx[i]}" v2="${idx[i + 1]}" v3="${idx[i + 2]}"/>`);
    out.push(t.join(''));
    out.push('</triangles></mesh></object>');
  });
  const parentId = used.length + 2;
  out.push(`<object id="${parentId}" name="${esc(meta.title ?? 'TopoForge model')}" type="model"><components>`);
  used.forEach((_, k) => out.push(`<component objectid="${k + 2}"/>`));
  out.push('</components></object>');
  out.push('</resources>');
  out.push(`<build><item objectid="${parentId}"/></build>`);
  out.push('</model>');

  const contentTypes =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>' +
    '</Types>';
  const rels =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>' +
    '</Relationships>';

  return zipSync(
    {
      '[Content_Types].xml': strToU8(contentTypes),
      '_rels/.rels': strToU8(rels),
      '3D/3dmodel.model': strToU8(out.join('\n')),
    },
    { level: 6 },
  );
}

const f = (n) => (Math.round(n * 1e4) / 1e4).toString();

function hexRGBA(hex) {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h.slice(0, 6);
  return `#${full.toUpperCase()}FF`;
}
