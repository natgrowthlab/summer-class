function requireAdmin(req, res, next) {
  if (req.session && req.session.adminUser) return next();
  res.redirect('/admin/login');
}

function requireStudent(req, res, next) {
  if (req.session && req.session.studentId) return next();
  res.redirect('/login');
}

function requireRole(...roles) {
  return async (req, res, next) => {
    const email = req.session?.adminUser?.email;
    if (!email) return res.status(403).json({ error: 'No tienes permiso para esta acción.' });
    try {
      const [users] = await pool.query('SELECT role FROM admin_users WHERE email=?', [email]);
      if (roles.includes(users[0]?.role)) return next();
      res.status(403).json({ error: 'No tienes permiso para esta acción.' });
    } catch (error) {
      next(error);
    }
  };
}
module.exports = { requireAdmin, requireRole, requireStudent };
const { pool } = require('../lib/db');
