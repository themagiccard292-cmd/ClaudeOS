import { memo, type ReactNode } from 'react';
import ReactMarkdown, { type Components, type Options } from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';
import { api } from '../lib/api';
import { CodeBlock } from './CodeBlock';

interface HastNode {
  type: string;
  value?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

/** Concatenate the text of a hast subtree (the raw code to copy, independent of highlight spans). */
function hastText(node: HastNode | undefined): string {
  if (!node) return '';
  if (node.type === 'text') return node.value ?? '';
  return (node.children ?? []).map(hastText).join('');
}

function languageOf(node: HastNode | undefined): string | undefined {
  const code = node?.children?.find((c) => c.tagName === 'code');
  const cls = code?.properties?.className;
  const list = Array.isArray(cls) ? cls.map(String) : [];
  return list.find((c) => c.startsWith('language-'))?.slice('language-'.length);
}

const components: Components = {
  pre({ node, children }) {
    const hast = node as unknown as HastNode | undefined;
    return (
      <CodeBlock language={languageOf(hast)} code={hastText(hast).replace(/\n$/, '')}>
        {children as ReactNode}
      </CodeBlock>
    );
  },
  a({ href, children }) {
    // Never navigate the panel itself: hand links to the desktop's browser.
    return (
      <a
        href={href}
        onClick={(e) => {
          e.preventDefault();
          if (href && /^(https?:|mailto:)/i.test(href)) void api().system.openExternal(href);
        }}
        title={href}
      >
        {children}
      </a>
    );
  },
  img({ alt }) {
    // Remote images could leak data; show the alt text instead.
    return <span className="text-muted">[{alt || 'image'}]</span>;
  },
};

const remarkPlugins: Options['remarkPlugins'] = [remarkGfm];
// Only highlight fences that name a language; auto-detection is slow and often wrong on short snippets.
const rehypePlugins: Options['rehypePlugins'] = [[rehypeHighlight, { detect: false }]];

/** Claude's reply text: GFM markdown in the editorial serif style. */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="prose-claude">
      <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
