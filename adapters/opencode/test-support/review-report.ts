/**
 * Plan item B2 — the reader the README describes for `format: "json"`: the
 * lines between the `review report` span's opener and its closing line, the
 * same backtick run alone on its line.
 */
export function reviewReportBody(output: string): string {
  const lines = output.split("\n")
  const opener = lines.findIndex((line) => /^`{4,}material: review report$/.test(line))
  if (opener === -1) throw new Error("no review report span")
  const fence = lines[opener]!.slice(0, lines[opener]!.indexOf("material: "))
  const close = lines.findIndex((line, index) => index > opener && line === fence)
  if (close === -1) throw new Error("the span has no closing line")
  return lines.slice(opener + 1, close).join("\n")
}

/** Everything outside that span: what precedes its notice line, and what follows its closing line. */
export function outsideReviewReport(output: string): { before: string; after: string } {
  const lines = output.split("\n")
  const opener = lines.findIndex((line) => /^`{4,}material: review report$/.test(line))
  const fence = lines[opener]!.slice(0, lines[opener]!.indexOf("material: "))
  const close = lines.findIndex((line, index) => index > opener && line === fence)
  // The notice is the line before the opener (`material()`).
  return { before: lines.slice(0, opener - 1).join("\n"), after: lines.slice(close + 1).join("\n") }
}
