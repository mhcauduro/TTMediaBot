# Histórico de versões

## 4.0.1 — 2026-09-05

- Validação da leitura do áudio antes de entregar a URL ao player, com renovação de tokens rejeitados pelo YouTube.
- Geração de tokens em sequência para evitar conflitos no provedor compartilhado.
- Preparação antecipada de até três próximas faixas, respeitando a fila e a ordem de reprodução.
- Cache de URLs validadas preservado entre recriações do container do YouTube.
- Repositório, identificação do fork e downloads de bibliotecas atualizados para `mhcauduro/TTMediaBot`.

Nos testes na VPS, uma faixa preparada começou em 0,47 segundo e as três próximas faixas passaram pela decodificação completa sem HTTP 403. Esses resultados não garantem o mesmo tempo em outras instalações: músicas ainda não preparadas podem precisar de alguns segundos para o YouTube liberar a URL.

O atualizador acompanha a branch `master` do remoto `origin`. Para receber esta versão, a instalação deve apontar para `https://github.com/mhcauduro/TTMediaBot` e estar com as atualizações habilitadas. A release não altera automaticamente instalações que ainda apontam para outro fork.
