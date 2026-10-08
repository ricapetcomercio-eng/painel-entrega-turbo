# Esqueleto de página admin nova

Copie a estrutura de `public/fechamento.html` (mais recente e limpa) e
troque o conteúdo. Pontos que não podem faltar, nesta ordem:

```html
<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Nome da Tela — Ricapet · Thapets</title>
<link rel="icon" type="image/png" href="favicon-ricapet.png?v=teal1">
<!-- 1. tema ANTES de qualquer CSS: evita piscar claro→escuro -->
<script>(function(){try{var t=localStorage.getItem('ricapet_tema2');if(t==='light'||t==='dark')document.documentElement.setAttribute('data-theme',t);}catch(e){}})();</script>
<!-- 2. sessão de login (redireciona pro login se não tiver) -->
<script src="assets/auth.js"></script>
<script src="assets/tema.js" defer></script>
<!-- 3. fonte -->
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap">
<!-- 4. design system ANTES do <style> da página -->
<link rel="stylesheet" href="assets/tokens-admin.css">
<style>
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg-page); color: var(--text-primary); font-family: var(--font-body); -webkit-font-smoothing: antialiased; font-variant-numeric: tabular-nums; }
  .shell { max-width: 1320px; margin: 0 auto; padding: 20px 24px 60px; display: flex; flex-direction: column; gap: 18px; }
  header { position: sticky; top: 0; z-index: 5; background: var(--bg-page); border-bottom: 1px solid var(--border); }
  .hrow { padding: 0 24px; min-height: 64px; display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
  .hrow h1 { font-size: 1.05rem; font-weight: 700; margin: 0 auto 0 0; display: flex; flex-direction: column; gap: 2px; line-height: 1.25; }
  .h-sub { font-size: 0.72rem; font-weight: 500; color: var(--text-secondary); }
  .updated-note { font-size: 11.5px; color: var(--text-secondary); }
  /* …só o que é desta página… */
</style>
</head>
<body class="marca-dagua">
<nav class="sidebar"> … copiar de uma página existente … </nav>
<div class="conteudo-principal">
  <header><div class="hrow">
    <h1>Nome da Tela<span class="h-sub">o que ela responde · período</span></h1>
    <span class="updated-note" id="atualizado"></span>
    <button type="button" class="btn primary" id="btn-atualizar">Atualizar</button>
  </div></header>
  <div class="shell" id="conteudo"><div class="loading-note">Carregando…</div></div>
</div>
</body>
</html>
```

## Sidebar

- Copie o `<nav class="sidebar">` inteiro de uma página existente (a
  ordem e os ícones são os mesmos em todas) e mova a classe `ativo` para o
  link da página nova.
- Página nova que deve aparecer no menu: adicione o `<a class="sidebar-link"
  data-menu-key="…">` **em todas as páginas com sidebar**, não só na nova,
  e a chave em `PAGINAS_PAINEL` (`lib/pontoAuth.js`) se o acesso for
  controlado por página (ver "Controle de acesso por página" no CLAUDE.md).
- O link "Painel TV" leva `?token=` — copie como está, não reescreva.

## Fora deste esqueleto

- `tv.html`: identidade própria (ver `painel-tv.md`).
- `login.html`: card centralizado, sem sidebar nem marca d'água.
- `estoque-atualizar.html`: celular, sem sidebar (topbar + tokens só de
  cor/fonte).
- Página com menu horizontal (`.topbar`): ver `bipagem-v2.html`.
