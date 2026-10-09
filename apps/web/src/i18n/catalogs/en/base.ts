const base = {
  status: {
    awaiting_payment: 'Awaiting payment',
    payment_review: 'Payment under review',
    paid: 'Paid',
    expired: 'Hold expired',
    cancelled: 'Cancelled',
    payment_rejected: 'Payment rejected',
  },
  method: {
    delivery: 'Delivery',
    in_person: 'In-person handover',
    package: 'Package',
  },
  priceDecimals: 'Enter a nonnegative price with at most {{digits}} decimal places.',
  priceTooLarge: 'Price is too large.',
};

export default base;
