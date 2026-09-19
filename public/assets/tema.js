// Ricapet — alternador de tema claro/escuro (identidade portal).
// A aplicação inicial (antes de pintar, pra não piscar) fica num <script>
// inline no <head> de cada página, lendo a mesma chave localStorage abaixo
// — este arquivo só cuida do BOTÃO (.tema-toggle) depois que a página já
// carregou. Sem escolha salva, segue prefers-color-scheme do sistema (sem
// setar o atributo data-theme), como pedido no pacote de identidade visual.
(function () {
  var CHAVE = 'ricapet_tema2';

  function temaEfetivo() {
    var salvo = null;
    try { salvo = localStorage.getItem(CHAVE); } catch (e) {}
    if (salvo === 'light' || salvo === 'dark') return salvo;
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  function aplicar(tema) {
    try { localStorage.setItem(CHAVE, tema); } catch (e) {}
    document.documentElement.setAttribute('data-theme', tema);
    atualizarBotoes();
  }

  function atualizarBotoes() {
    var atual = temaEfetivo();
    document.querySelectorAll('[data-tema-toggle] button').forEach(function (b) {
      b.classList.toggle('ativo', b.dataset.tema === atual);
    });
  }

  function iniciar() {
    document.querySelectorAll('[data-tema-toggle] button').forEach(function (b) {
      b.addEventListener('click', function () { aplicar(b.dataset.tema); });
    });
    atualizarBotoes();
  }

  window.RicapetTema = { aplicar: aplicar, temaEfetivo: temaEfetivo };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', iniciar);
  } else {
    iniciar();
  }
})();
