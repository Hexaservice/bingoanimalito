# Inventario de lecturas reales de `premiosPagosdirectos`

Fecha de corte: 2026-04-14.

## 1) Frontend

Búsqueda ejecutada:

```bash
rg -n "premiosPagosdirectos" public
```

Resultado: **sin coincidencias**.

Conclusión: no hay lecturas activas del frontend para `premiosPagosdirectos`.

## 2) Scripts

Búsqueda ejecutada:

```bash
rg -n "premiosPagosdirectos" scripts
```

Resultado: **sin coincidencias**.

Conclusión: no hay scripts operativos que lean `premiosPagosdirectos`.

## 3) Reportes

Búsqueda ejecutada:

```bash
rg -n "premiosPagosdirectos" public/reportes.html
```

Resultado: **sin coincidencias**.

Conclusión: `reportes.html` no consume `premiosPagosdirectos`.

## 4) Backend (contexto para retiro de doble escritura)

Búsqueda ejecutada:

```bash
rg -n "premiosPagosdirectos" uploadServer.js
```

Hallazgos relevantes:
- Escritura espejo desde generación de premios oficiales.
- Escritura espejo desde reconciliación/acreditación.

Acción aplicada en este PR:
- Escritura espejo condicionada por feature flag temporal `PREMIOS_PAGOS_DIRECTOS_MIRROR_ENABLED`.
- Valor por defecto: `false` (no espejo).
- Rollback: habilitar `true` y reiniciar backend.
