<template>
  <div class="markdown-body" ref="containerRef" v-html="html"></div>
</template>

<script setup lang="ts">
import { computed, ref, watch, nextTick } from 'vue';
import MarkdownIt from 'markdown-it';
import hljs from 'highlight.js/lib/common';
import DOMPurify from 'dompurify';
import 'highlight.js/styles/github-dark.css';

const props = defineProps<{ content: string; baseUrl?: string; repoUrl?: string }>();

// 图片加载失败时显示的占位图（避免破图标）
const IMG_PLACEHOLDER =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="80">' +
      '<rect width="100%" height="100%" fill="#f5f5f5"/>' +
      '<text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" font-size="13" fill="#999">图片未加载，可点「在 GitHub 查看完整 README」</text>' +
      '</svg>',
  );

// 收集相对路径图片的多个候选绝对地址：README 目录、仓库根目录、各上级目录
function buildCandidates(raw: string | null): string[] {
  if (!raw) return [];
  if (/^(https?:)?\/\//i.test(raw) || /^(data|mailto|tel):/i.test(raw) || raw.startsWith('#')) {
    return [raw];
  }
  const out: string[] = [];
  const tryAdd = (base?: string) => {
    if (!base) return;
    try {
      const u = new URL(raw, base).href;
      if (!out.includes(u)) out.push(u);
    } catch {
      /* ignore */
    }
  };
  tryAdd(props.baseUrl);
  tryAdd(props.repoUrl);
  // 逐层向上尝试（README 在子目录时，图片常相对仓库根）
  if (props.baseUrl) {
    const b = props.baseUrl.endsWith('/') ? props.baseUrl.slice(0, -1) : props.baseUrl;
    const segs = b.split('/');
    while (segs.length > 6) {
      segs.pop();
      tryAdd(segs.join('/') + '/');
    }
  }
  return out.length ? out : [raw];
}

// 外链统一加 rel/target，防止 opener 攻击
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A' && node.getAttribute('href')) {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

const md: MarkdownIt = new MarkdownIt({
  html: true, // 允许原始 HTML（如 <img>），由 DOMPurify 消毒防 XSS
  linkify: true,
  typographer: true,
  breaks: false,
  highlight(str: string, lang: string): string {
    if (lang && hljs.getLanguage(lang)) {
      try {
        return (
          '<pre class="hljs"><code>' +
          hljs.highlight(str, { language: lang, ignoreIllegals: true }).value +
          '</code></pre>'
        );
      } catch {
        /* fall through */
      }
    }
    return '<pre class="hljs"><code>' + md.utils.escapeHtml(str) + '</code></pre>';
  },
});

const html = computed(() => {
  const clean = DOMPurify.sanitize(md.render(props.content || ''));
  if (!props.baseUrl && !props.repoUrl) return clean;
  // 渲染后统一 rebase 相对路径（同时覆盖 Markdown 语法图片与原始 <img> HTML）
  const doc = new DOMParser().parseFromString(clean, 'text/html');
  doc.querySelectorAll('img[src]').forEach((el) => {
    const cands = buildCandidates(el.getAttribute('src'));
    el.setAttribute('src', cands[0]);
    el.setAttribute('data-candidates', JSON.stringify(cands));
    el.setAttribute('data-idx', '0');
  });
  doc.querySelectorAll('a[href]').forEach((el) => {
    const href = el.getAttribute('href');
    if (
      href &&
      !/^(https?:)?\/\//i.test(href) &&
      !/^(data|mailto|tel):/i.test(href) &&
      !href.startsWith('#') &&
      props.baseUrl
    ) {
      try {
        el.setAttribute('href', new URL(href, props.baseUrl).href);
      } catch {
        /* ignore */
      }
    }
  });
  return doc.body.innerHTML;
});

const containerRef = ref<HTMLElement | null>(null);

// 渲染后给图片挂 onerror 回退：依次尝试候选地址，全部失败则优雅降级为占位图
watch(
  html,
  async () => {
    await nextTick();
    const root = containerRef.value;
    if (!root) return;
    root.querySelectorAll<HTMLImageElement>('img[data-candidates]').forEach((img) => {
      const cands: string[] = JSON.parse(img.getAttribute('data-candidates') || '[]');
      let idx = Number(img.getAttribute('data-idx') || '0');
      img.onerror = () => {
        idx++;
        if (idx < cands.length) {
          img.setAttribute('data-idx', String(idx));
          img.src = cands[idx];
        } else {
          img.onerror = null;
          img.src = IMG_PLACEHOLDER;
        }
      };
    });
  },
  { immediate: true, flush: 'post' },
);
</script>

<style scoped>
.markdown-body {
  font-size: 13px;
  line-height: 1.7;
  color: var(--text-color-2);
  word-break: break-word;
}

.markdown-body :deep(h1),
.markdown-body :deep(h2),
.markdown-body :deep(h3),
.markdown-body :deep(h4) {
  margin: 16px 0 8px;
  font-weight: 600;
  line-height: 1.3;
}

.markdown-body :deep(h1) { font-size: 20px; }
.markdown-body :deep(h2) { font-size: 17px; }
.markdown-body :deep(h3) { font-size: 15px; }

.markdown-body :deep(p) { margin: 8px 0; }

.markdown-body :deep(a) {
  color: var(--primary-color);
  text-decoration: none;
}
.markdown-body :deep(a:hover) { text-decoration: underline; }

.markdown-body :deep(ul),
.markdown-body :deep(ol) {
  padding-left: 22px;
  margin: 8px 0;
}

.markdown-body :deep(li) { margin: 4px 0; }

.markdown-body :deep(code) {
  background: var(--action-color);
  padding: 1px 5px;
  border-radius: 4px;
  font-size: 12px;
  font-family: monospace;
}

.markdown-body :deep(pre.hljs) {
  margin: 10px 0;
  padding: 12px 14px;
  border-radius: 6px;
  overflow-x: auto;
  font-size: 12px;
  line-height: 1.5;
}

.markdown-body :deep(pre.hljs code) {
  background: transparent;
  padding: 0;
}

.markdown-body :deep(blockquote) {
  margin: 8px 0;
  padding: 4px 12px;
  border-left: 3px solid var(--primary-color);
  background: var(--action-color);
  color: var(--text-color-3);
}

.markdown-body :deep(table) {
  border-collapse: collapse;
  width: 100%;
  margin: 10px 0;
  font-size: 12px;
}
.markdown-body :deep(th),
.markdown-body :deep(td) {
  border: 1px solid var(--divider-color);
  padding: 6px 10px;
  text-align: left;
}

.markdown-body :deep(img) {
  max-width: 100%;
  border-radius: 6px;
  margin: 8px 0;
}

.markdown-body :deep(hr) {
  border: none;
  border-top: 1px solid var(--divider-color);
  margin: 14px 0;
}
</style>
