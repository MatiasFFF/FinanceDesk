import { markdownBlocks, safeMarkdownHref } from "./aiWorkflow.js";

function Inline({ text }) {
  const pieces = String(text || "").split(/(`[^`\n]+`|\*\*[^*\n]+\*\*|\*[^*\n]+\*|\[[^\]\n]+\]\([^\s)]+\))/g);
  return pieces.map((piece, index) => {
    if (piece.startsWith("`") && piece.endsWith("`")) return <code key={index}>{piece.slice(1, -1)}</code>;
    if (piece.startsWith("**") && piece.endsWith("**")) return <strong key={index}>{piece.slice(2, -2)}</strong>;
    if (piece.startsWith("*") && piece.endsWith("*")) return <em key={index}>{piece.slice(1, -1)}</em>;
    const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(piece);
    if (link) { const href = safeMarkdownHref(link[2]); return href ? <a key={index} href={href} target="_blank" rel="noopener noreferrer">{link[1]}</a> : <span key={index}>{link[1]}</span>; }
    return piece;
  });
}

export function AiMessageContent({ text }) {
  return <div className="ai-markdown">{markdownBlocks(text).map((block, index) => {
    if (block.type === "heading") { const Heading = `h${block.level}`; return <Heading key={index}><Inline text={block.text} /></Heading>; }
    if (block.type === "list") { const List = block.ordered ? "ol" : "ul"; return <List key={index} start={block.ordered ? block.start : undefined}>{block.items.map((item, itemIndex) => <li key={itemIndex}><Inline text={item} /></li>)}</List>; }
    if (block.type === "table") return <div className="ai-markdown-table" key={index} tabIndex={0} role="region" aria-label="助手回复表格"><table><thead><tr>{block.headers.map((header, column) => <th scope="col" key={column}><Inline text={header} /></th>)}</tr></thead><tbody>{block.rows.map((row, rowIndex) => <tr key={rowIndex}>{block.headers.map((_, column) => <td key={column}><Inline text={row[column] || ""} /></td>)}</tr>)}</tbody></table></div>;
    if (block.type === "code") return <pre key={index}><code>{block.text}</code></pre>;
    if (block.type === "quote") return <blockquote key={index}><Inline text={block.text} /></blockquote>;
    return <p key={index}><Inline text={block.text} /></p>;
  })}</div>;
}
