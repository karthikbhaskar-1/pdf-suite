# Generates the Word-export corpus file via Word COM (Microsoft Office), then SaveAs2 as PDF (format 17).
# Output: tests/trial/corpus/word-export/word-export.{docx,pdf}
# Status (2026-11-09): in this session, Word's SaveAs2/ExportAsFixedFormat calls did not return
# (even to a temp path), so the corpus file was not produced. Rerun from an interactive session.
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$out = Join-Path $here 'corpus\word-export'
New-Item -ItemType Directory -Force -Path $out | Out-Null
$docx = Join-Path $out 'word-export.docx'
$pdf = Join-Path $out 'word-export.pdf'

$word = New-Object -ComObject Word.Application
$word.Visible = $false
$word.DisplayAlerts = 0
try {
  $doc = $word.Documents.Add()
  $items = @(
    @('Heading 1', 'Quarterly Engineering Review'),
    @('Normal', 'The migration to the new rendering pipeline reduced median page load time by roughly thirty percent across the test corpus, while the memory footprint stayed within the agreed budget for large documents.'),
    @('Heading 2', 'Findings'),
    @('Normal', 'Several teams reported that the reviewed text layer behaved consistently when zoomed, rotated, or searched, although kerning on italic headings needed a manual correction.'),
    @('List Bullet', 'Search latency fell below the target on every sample file.'),
    @('List Bullet', 'Annotation rendering matched the baseline in all regression runs.'),
    @('Normal', 'Next steps are to finalize the editing spike and record the outcome in the decision log before the planning meeting.')
  )
  foreach ($it in $items) {
    $p = $doc.Content.Paragraphs.Add()
    $p.Range.Text = $it[1]
    $p.Range.Style = $doc.Styles.Item($it[0])
    $p.Range.InsertParagraphAfter()
  }
  $doc.SaveAs2($docx, 16)
  $doc.SaveAs2($pdf, 17)
  $doc.Close(0)
} finally {
  $word.Quit()
}
