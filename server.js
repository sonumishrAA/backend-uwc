import express from 'express';
import axios from 'axios';
import crypto from 'crypto';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

// Initialize environment variables
dotenv.config();

const app = express();

// Middleware
app.use(express.json());
app.use(
  cors({
    origin: 'https://uwcindia.in',
    methods: ['GET', 'POST']
  })
);

// Supabase Client Configuration
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// PhonePe Configuration
const PHONEPE_CONFIG = {
  merchantId: process.env.MERCHANT_ID,
  merchantKey: process.env.MERCHANT_KEY,
  baseUrl: 'https://api.phonepe.com/apis/hermes',
  // This is the backend endpoint for PhonePe to redirect to upon success
  redirectUrl: 'https://backend-uwc.onrender.com/payment-success',
  // Frontend URLs for user redirection after processing
  frontendSuccessUrl: 'https://uwcindia.in/payment-success',
  frontendFailureUrl: 'https://uwcindia.in/payment-failed'
};

// Utility Functions
const generatePhonePeChecksum = (payload, endpoint) => {
  const string = payload + endpoint + PHONEPE_CONFIG.merchantKey;
  return crypto.createHash('sha256').update(string).digest('hex') + '###1';
};

// API Endpoints
app.post('/create-order', async (req, res) => {
  try {
    // Validate request body
    const { name, mobileNumber, amount, address, service } = req.body;
    if (!name || !mobileNumber || !amount || !address || !service) {
      return res.status(400).json({ error: 'All fields are required' });
    }

    // Generate unique IDs for the order and transaction
    const orderId = uuidv4();
    const transactionId = `TXN_${Date.now()}`;

    // Save order details to Supabase (ensure your orders table has the following columns)
    const { error: dbError } = await supabase
      .from('orders')
      .insert({
        id: orderId,
        name,
        phone: mobileNumber,
        address,
        service,
        amount,
        status: 'pending'
      });

    if (dbError) {
      console.error('Supabase Error:', dbError);
      return res.status(500).json({ error: 'Database operation failed' });
    }

    // Prepare the payment payload as per PhonePe API requirements
    const paymentPayload = {
      merchantId: PHONEPE_CONFIG.merchantId,
      merchantTransactionId: transactionId,
      merchantUserId: orderId,
      amount: Number(amount) * 100, // Amount in paisa
      redirectUrl: `${PHONEPE_CONFIG.redirectUrl}?orderId=${orderId}`,
      redirectMode: 'GET',
      paymentInstrument: { type: 'UPI_QR_CODE' }
    };

    // Log the payload for debugging (remove in production)
    console.log('Payment Payload:', paymentPayload);

    // Convert payload to base64 and generate checksum
    const payloadBase64 = Buffer.from(JSON.stringify(paymentPayload)).toString('base64');
    const checksum = generatePhonePeChecksum(payloadBase64, '/pg/v1/pay');

    // Log base64 payload and checksum for debugging (remove in production)
    console.log('Base64 Payload:', payloadBase64);
    console.log('Checksum:', checksum);

    // Make API request to PhonePe
    const response = await axios.post(
      `${PHONEPE_CONFIG.baseUrl}/pg/v1/pay`,
      { request: payloadBase64 },
      {
        headers: {
          'Content-Type': 'application/json',
          'X-VERIFY': checksum,
          'X-MERCHANT-ID': PHONEPE_CONFIG.merchantId
        }
      }
    );

    // Check if PhonePe provided a redirect URL
    if (!response.data?.data?.instrumentResponse?.redirectInfo?.url) {
      console.error('PhonePe API Error:', response.data);
      return res.status(500).json({ error: 'Payment gateway error' });
    }

    // Return the redirect URL to the client
    return res.json({
      success: true,
      paymentUrl: response.data.data.instrumentResponse.redirectInfo.url
    });
  } catch (error) {
    console.error('Server Error:', {
      message: error.message,
      stack: error.stack,
      response: error.response?.data
    });
    return res.status(500).json({
      error: 'Transaction failed',
      details: error.response?.data || error.message
    });
  }
});

// Payment Status Handlers
app.get('/payment-success', async (req, res) => {
  try {
    const { orderId } = req.query;
    
    // Update order status to success in Supabase
    const { error } = await supabase
      .from('orders')
      .update({ status: 'success' })
      .eq('id', orderId);

    if (error) throw error;

    // Redirect to frontend success page with orderId as a query parameter
    res.redirect(`${PHONEPE_CONFIG.frontendSuccessUrl}?orderId=${orderId}`);
  } catch (error) {
    console.error('Payment Success Error:', error);
    res.redirect(PHONEPE_CONFIG.frontendFailureUrl);
  }
});

app.get('/payment-failed', async (req, res) => {
  try {
    const { orderId } = req.query;
    
    // Update order status to failed in Supabase
    await supabase
      .from('orders')
      .update({ status: 'failed' })
      .eq('id', orderId);

    // Redirect to frontend failure page with orderId as a query parameter
    res.redirect(`${PHONEPE_CONFIG.frontendFailureUrl}?orderId=${orderId}`);
  } catch (error) {
    console.error('Payment Failure Error:', error);
    res.redirect(PHONEPE_CONFIG.frontendFailureUrl);
  }
});

// Server Initialization
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log('PhonePe Configuration:', {
    merchantId: PHONEPE_CONFIG.merchantId,
    baseUrl: PHONEPE_CONFIG.baseUrl
  });
});
