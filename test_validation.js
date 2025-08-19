// Script para probar la validación de horarios
const fetch = require('node-fetch');

async function testValidation() {
  console.log('=== PRUEBA DE VALIDACIÓN DE HORARIOS ===\n');
  
  const tests = [
    {
      name: 'Reserva válida - 21:30 (termina a 23:30)',
      data: { fecha: '2025-08-19', hora: '21:30', duracion: 120 }
    },
    {
      name: 'Reserva inválida - 22:30 (termina a 00:30)',
      data: { fecha: '2025-08-19', hora: '22:30', duracion: 120 }
    },
    {
      name: 'Reserva muy temprano - 12:00 (antes de apertura)',
      data: { fecha: '2025-08-19', hora: '12:00', duracion: 120 }
    }
  ];
  
  for (const test of tests) {
    console.log(`\n--- ${test.name} ---`);
    console.log(`Datos: ${JSON.stringify(test.data)}`);
    
    try {
      const response = await fetch('https://backend-2-production-227a.up.railway.app/api/validar-horario-reserva', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(test.data)
      });
      
      const result = await response.json();
      console.log(`Estado: ${response.status}`);
      console.log(`Respuesta:`, result);
      
    } catch (error) {
      console.log(`Error:`, error.message);
    }
  }
}

testValidation().catch(console.error);