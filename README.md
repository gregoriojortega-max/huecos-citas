# huecos-citas

Lee los huecos libres de las dos páginas públicas de reserva (ginecología 30 min y ecografía 4D 60 min)
y los envía a un webhook de n8n cada 30 minutos, 24 h al día.

- `scrape.mjs`: abre las páginas con Chrome sin pantalla (Playwright), recorre 4 semanas y asigna cada hora a su día.
- `.github/workflows/huecos.yml`: programación (cada 30 min) + latido semanal.
- No contiene secretos. `WEBHOOK_URL` y `WEBHOOK_TOKEN` se guardan en Settings → Secrets and variables → Actions.
- Si una página no se lee bien, no se envía nada de ella y la ejecución aparece en rojo en la pestaña Actions.
