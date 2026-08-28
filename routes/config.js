const express = require('express');
const router = express.Router();
const { PLAN_COSTS, TALONARIO_CONFIG } = require('../lib/helpers');

router.get('/config', (req, res) => {
  res.json({
    costs: PLAN_COSTS,
    talonario: TALONARIO_CONFIG,
    bankInfo: {
      bank: 'Bancolombia',
      type: 'Ahorros',
      account: '123-456789-00',
      holder: 'Summer Class SAS'
    }
  });
});

module.exports = router;
