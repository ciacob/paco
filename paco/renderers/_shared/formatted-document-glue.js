'use strict';

/**
 * paco/renderers/_shared/formatted-document-glue.js
 *
 * Shared implementation behind BOTH formatted-document/glue.js and
 * formatted-document-plain/glue.js. Those two renderer.json manifests
 * exist only because this project's existing text-vs-binary
 * classification splits text-extractor's own supported-format list
 * across file_mode "binary" (docx/pptx/xlsx/odt/odp/ods/pdf/rtf — all
 * MIME-detected) and file_mode "text" (csv/md/html — not MIME-detected,
 * classified via content sniff instead) — see either manifest's own
 * description for the empirical verification behind that split. Nothing
 * about the actual extraction call differs between the two: text-extractor
 * takes the same (fileType, config) shape regardless, so both manifests'
 * glue.js files just re-export this one implementation rather than
 * maintaining two copies of an identical function.
 *
 * Pure — no I/O, not even a require() of text-extractor itself beyond
 * resolving its path.
 *
 * @param {string} ext — file extension without the leading dot, e.g. 'docx', 'md'
 * @returns {{ modulePath: string, exportName: string, fixedArgs: any[] }}
 */
function buildInvocation(ext) {
  return {
    modulePath: require.resolve('../../extractors/text-extractor/src/textExtractor'),
    exportName: 'getDocumentPreview',
    fixedArgs: [ext, {}],
  };
}

module.exports = { buildInvocation };
