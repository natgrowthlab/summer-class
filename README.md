# 🎒 Summer Class — Vercel deployment

## Production architecture

This version runs on Vercel with Neon PostgreSQL for data and sessions, plus
Vercel Blob for durable payment receipts. It adds role-based admin accounts,
CSV exports, email confirmations, passwordless student access links, and a
weekly balance reminder. Create the Neon database and Blob store in Vercel,
then set every value in `.env.example`.

Set `ADMIN_EMAIL` and `ADMIN_PASSWORD` before the first deployment. The first
successful sign-in creates the owner account; subsequent credentials are stored
as password hashes in PostgreSQL.

## Qué cambió respecto a la versión anterior (PostgreSQL)

| Antes (PostgreSQL/Neon) | Ahora (MySQL/Hostinger) |
|---|---|
| `pg` + `connect-pg-simple` | `mysql2` + `express-mysql-session` |
| IDs generados por la DB (`gen_random_uuid()`) | IDs generados en Node con `uuid` antes de insertar |
| Placeholders `$1, $2...` | Placeholders `?` |
| `RETURNING id` | No se usa — el ID ya se conoce de antemano |
| `ORDER BY RANDOM()` | `ORDER BY RAND()` |
| `ON CONFLICT DO NOTHING` | `INSERT IGNORE` |
| Variable `DATABASE_URL` | Variables separadas: `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` |

El **frontend no cambió en nada** — ninguna página HTML, ningún CSS. La migración es 100% backend.

## 🔧 Bonus: arreglo de consistencia

En la versión anterior, la asignación automática de talonarios (al aprobar un pago de Bono de Apoyo) solo ocurría si el admin aprobaba desde el **panel web**. Si aprobaba con los botones de **Telegram** (✅/❌), el talonario no se asignaba.

Ahora ambos caminos usan la misma función compartida (`lib/paymentActions.js`), así que el comportamiento es idéntico sin importar por dónde apruebes.

---

## 📋 Antes de desplegar

### 1. Verifica el host de tu base de datos

Le puse `DB_HOST=localhost` por defecto en el `.env`, que es lo correcto cuando tu base
de datos MySQL y tu app Node.js están en la **misma cuenta de Hostinger** (tu caso).

Si al arrancar ves un error de conexión, verifica el host exacto en:
**hPanel → Bases de datos → MySQL Databases** → busca "Host de la base de datos"
(a veces Hostinger muestra `127.0.0.1` en vez de `localhost` — prueba ese valor si falla).

### 2. La base de datos ya debe existir

Tú ya tienes creada `u835980379_summerdb` con el usuario `u835980379_SuperAdmin` con
todos los permisos. La app crea las tablas automáticamente la primera vez que arranca
(`CREATE TABLE IF NOT EXISTS`), no necesitas crear nada manualmente en phpMyAdmin.

### 3. Variables de entorno

Mismo flujo de siempre — sube el archivo `.env.production` (renombrado a `.env`) a la
raíz de tu app en Hostinger vía File Manager. Ya viene con tus credenciales reales de
MySQL completadas; solo te falta llenar:
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_ADMIN_CHAT_ID`
- `ADMIN_PASSWORD`
- `SESSION_SECRET`

---

## 🚀 Deploy

Tu flujo con GitHub no cambia:

1. Haz commit y push de este proyecto a tu repositorio
2. Hostinger jala el código (git deploy)
3. Sube el `.env` manualmente una sola vez (no se borra entre deploys de git)
4. En el panel de Hostinger → tu app Node.js → **Restart**

Al arrancar, deberías ver en los logs:
```
✅ Base de datos MySQL inicializada correctamente
🚀 Summer Class (MySQL) corriendo en puerto XXXX
```

---

## 🗃️ Estructura de tablas creadas automáticamente

- `students` — datos de estudiantes
- `enrollments` — inscripciones (plan + método de pago)
- `payments` — abonos y comprobantes
- `talonario_catalog` — talonarios disponibles/asignados (los ingresa el admin)
- `bonos` — los bonos individuales de cada talonario (3 cuotas c/u)
- `sessions` — sesiones de login (creada automáticamente por `express-mysql-session`)

---

## 🐛 Troubleshooting

**Error `ER_ACCESS_DENIED_ERROR` al arrancar**
→ Usuario o contraseña incorrectos. Verifica en hPanel que el usuario
`u835980379_SuperAdmin` tenga permisos sobre la base `u835980379_summerdb`
(hPanel → Bases de datos → MySQL Databases → revisa la sección de usuarios asociados).

**Error `ENOTFOUND` o `ECONNREFUSED`**
→ El `DB_HOST` está mal. Prueba cambiando entre `localhost` y `127.0.0.1`.

**Error `ER_NOT_SUPPORTED_AUTH_MODE`**
→ Tu MySQL usa un método de autenticación que `mysql2` necesita que actives. Esto es
raro en Hostinger (suelen usar `mysql_native_password` por defecto), pero si pasa,
contacta soporte de Hostinger para confirmar el método de autenticación del usuario.

**Las tablas no se crean**
→ Revisa que el usuario tenga permiso `CREATE` sobre la base de datos (debería tenerlo
por defecto al ser el usuario principal que creaste).
