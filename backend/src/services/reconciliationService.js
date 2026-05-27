'use strict';

/**
 * Reconciliation Service — Nightly totalPaid drift correction
 *
 * Runs once per night (configurable via RECONCILIATION_INTERVAL_MS).
 * For every student whose stored totalPaid differs from the sum of their
 * confirmed payments, the stored value is corrected and a WARN log is emitted.
 */

const Student = require('../models/studentModel');
const Payment = require('../models/paymentModel');
const logger = require('../utils/logger').child('ReconciliationService');

// Default: run once every 24 hours
const INTERVAL_MS = parseInt(process.env.RECONCILIATION_INTERVAL_MS || String(24 * 60 * 60 * 1000), 10);

let _timer = null;

/**
 * Reconcile all students for a given schoolId (or all schools if omitted).
 * Returns a summary { checked, fixed, errors }.
 */
async function reconcileAll(schoolId) {
  const filter = schoolId ? { schoolId } : {};
  const students = await Student.find(filter).lean();

  let fixed = 0;
  let errors = 0;

  for (const student of students) {
    try {
      const result = await Payment.aggregate([
        {
          $match: {
            schoolId: student.schoolId,
            studentId: student.studentId,
            status: 'SUCCESS',
            deletedAt: null,
          },
        },
        { $group: { _id: null, computedTotal: { $sum: '$amount' } } },
      ]);

      const computedTotal = result.length > 0 ? result[0].computedTotal : 0;
      const storedTotal = student.totalPaid || 0;

      if (Math.abs(computedTotal - storedTotal) > 0.0000001) {
        logger.warn('Reconciliation mismatch — correcting', {
          schoolId: student.schoolId,
          studentId: student.studentId,
          storedTotal,
          computedTotal,
          diff: computedTotal - storedTotal,
        });

        await Student.findOneAndUpdate(
          { schoolId: student.schoolId, studentId: student.studentId },
          {
            totalPaid: computedTotal,
            remainingBalance: Math.max(0, student.feeAmount - computedTotal),
            feePaid: computedTotal >= student.feeAmount,
          },
        );
        fixed++;
      }
    } catch (err) {
      errors++;
      logger.error('Reconciliation error for student', {
        schoolId: student.schoolId,
        studentId: student.studentId,
        error: err.message,
      });
    }
  }

  logger.info('Nightly reconciliation complete', {
    checked: students.length,
    fixed,
    errors,
  });

  return { checked: students.length, fixed, errors };
}

function startReconciliationScheduler() {
  if (_timer) return;
  logger.info('Reconciliation scheduler started', { intervalMs: INTERVAL_MS });
  _timer = setInterval(async () => {
    try {
      await reconcileAll();
    } catch (err) {
      logger.error('Reconciliation scheduler error', { error: err.message });
    }
  }, INTERVAL_MS);
  // Allow the process to exit even if the timer is active
  if (_timer.unref) _timer.unref();
}

function stopReconciliationScheduler() {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
    logger.info('Reconciliation scheduler stopped');
  }
}

module.exports = { reconcileAll, startReconciliationScheduler, stopReconciliationScheduler };
