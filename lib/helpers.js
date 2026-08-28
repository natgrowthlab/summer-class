try { require('dotenv').config(); } catch(e) {}

const PLAN_COSTS = {
  san_andres: parseInt(process.env.COST_SAN_ANDRES) || 3200000,
  costa_atlantica: parseInt(process.env.COST_COSTA_ATLANTICA) || 2800000
};

const PLAN_NAMES = {
  san_andres: 'San Andrés Islas',
  costa_atlantica: 'Costa Atlántica'
};

// Configuración de talonarios por plan
// - Costo para el ESTUDIANTE (precio de compra del talonario): $10.000
// - Bonos por talonario: 37 (Costa) / 43 (San Andrés)
// - Costo del bono para el COMPRADOR FINAL: $60.000 (Costa) / $70.000 (San Andrés)
const TALONARIO_CONFIG = {
  costa_atlantica: {
    student_price:  10000,
    bonos_per_ticket: 37,
    bono_price:     60000,
    cuotas:         3,
    cuota_amount:   20000
  },
  san_andres: {
    student_price:  10000,
    bonos_per_ticket: 43,
    bono_price:     70000,
    cuotas:         3,
    cuota_amount:   Math.round(70000 / 3)
  }
};

const RAFFLE = {
  ticket_price:     10000,
  milestone_amount: 20000,
  milestones: [
    { id: 1, name: 'Cuota 1' },
    { id: 2, name: 'Cuota 2' },
    { id: 3, name: 'Cuota final' }
  ]
};

function calcDebt(enrollment) {
  const total = enrollment.total_cost;
  const paid = parseInt(enrollment.amount_paid) || 0;
  const balance = Math.max(0, total - paid);
  const pct = total > 0 ? Math.min(100, Math.round((paid / total) * 100)) : 0;
  return { total, paid, balance, pct, isFullyPaid: balance === 0 };
}

function formatCOP(n) {
  return '$' + Number(n).toLocaleString('es-CO');
}

function getPlanCost(plan) {
  return PLAN_COSTS[plan] || 0;
}

module.exports = { PLAN_COSTS, PLAN_NAMES, RAFFLE, TALONARIO_CONFIG, calcDebt, formatCOP, getPlanCost };
