function requireAdmin(req, res, next) {
  if (req.session && req.session.adminUser) return next();
  res.redirect('/admin/login');
}

function requireStudent(req, res, next) {
  if (req.session && req.session.studentId) return next();
  res.redirect('/login');
}

function requireRole(...roles) {
  return (req, res, next) => req.session?.adminUser && roles.includes(req.session.adminUser.role) ? next() : res.status(403).json({ error: 'No tienes permiso para esta acción.' });
}
module.exports = { requireAdmin, requireRole, requireStudent };
