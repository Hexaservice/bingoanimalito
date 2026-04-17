# Scripts legacy (uso manual excepcional)

Este directorio documenta scripts que **no** están conectados al runtime del sistema (`public/` + `uploadServer.js`) ni a `npm scripts` operativos.

## Inventario
- `../../initUsers.js`: bootstrap histórico de usuarios/roles iniciales en Firestore.
- `../../initRoles.js`: bootstrap histórico de colección `roles`.
- `../migrarPremiosPendientesDirectosSubcoleccion.js`: migración histórica de mapa legacy a subcolección en `Billetera/{email}/premiosPendientesDirectos`.
- `../gpt-pr-tools.mjs`: utilidad legacy para automatización de PR en CI externo.

## Política de uso
1. Ejecutar solo con respaldo previo y ventana de mantenimiento.
2. Incluir plan de rollback explícito por archivo/colección.
3. No ejecutar en producción sin validación previa en entorno de prueba.

## Estado
- Marcados con `@deprecated` para evitar uso accidental.
- Se conservan temporalmente para compatibilidad operativa histórica.
