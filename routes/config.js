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
      account: '70600002695',
      key: '@summerclass',
      holder: 'Summer Class SAS'
    }
  });
});

module.exports = router;
