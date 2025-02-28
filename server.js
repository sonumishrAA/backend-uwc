import express from "express";
import axios from "axios";
import crypto from "crypto";
import cors from "cors";
import { v4 as uuidv4 } from "uuid";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json());
app.use(cors({
  origin: ["https://uwcindia.in", "http://localhost:3000"],
  methods: ["GET", "POST"],
  credentials: true
}));

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// PhonePe Configuration
const MERCHANT_ID = process.env.MERCHANT_ID;
const MERCHANT_KEY = process.env.MERCHANT_KEY;
const KEY_INDEX = 1;
const MERCHANT_BASE_URL = "https://api.phonepe.com/apis/hermes/pg/v1/pay";
const MERCHANT_STATUS_URL = "https://api.phonepe.com/apis/hermes/pg/v1/status";

// Utility Functions
const generateChecksum = (payload, endpoint) => {
  const string = payload + endpoint + MERCHANT_KEY;
  return crypto.createHash("sha256").update(string).digest("hex") + "###" + KEY_INDEX;
};

// Routes
app.post("/create-order", async (req, res) => {
  try {
    const { name, phone, amount, address, service } = req.body;
    const orderId = uuidv4();

    // Create initial order record
    const { error: dbError } = await supabase
      .from('orders')
      .insert([{
        order_id: orderId,
        amount,
        status: 'pending',
        customer_name: name,
        phone,
        address,
        service
      }]);

    if (dbError) throw dbError;

    // PhonePe payload
    const paymentPayload = {
      merchantId: MERCHANT_ID,
      merchantTransactionId: orderId,
      merchantUserId: uuidv4(),
      amount: Number(amount) * 100,
      currency: "INR",
      redirectUrl: `${process.env.BACKEND_URL}/payment-success`,
      redirectMode: "POST",
      mobileNumber: phone,
      paymentInstrument: { type: "PAY_PAGE" }
    };

    const payload = Buffer.from(JSON.stringify(paymentPayload)).toString("base64");
    const checksum = generateChecksum(payload, "/pg/v1/pay");

    const response = await axios.post(MERCHANT_BASE_URL, { request: payload }, {
      headers: { "X-VERIFY": checksum }
    });

    res.json({
      success: true,
      paymentUrl: response.data.data.instrumentResponse.redirectInfo.url
    });
  } catch (error) {
    console.error("Create order error:", error);
    res.status(500).json({ error: error.message });
  }
});

app.post("/payment-success", async (req, res) => {
  try {
    const { merchantTransactionId } = req.body;
    
    // Verify payment status
    const checksum = generateChecksum("", `/pg/v1/status/${MERCHANT_ID}/${merchantTransactionId}`);
    const { data } = await axios.get(
      `${MERCHANT_STATUS_URL}/${MERCHANT_ID}/${merchantTransactionId}`,
      { headers: { "X-VERIFY": checksum } }
    );

    // Update order status
    const { error } = await supabase
      .from('orders')
      .update({
        status: data.code === "PAYMENT_SUCCESS" ? "paid" : "failed",
        transaction_id: data.transactionId,
        payment_method: data.paymentInstrument?.type,
        updated_at: new Date().toISOString()
      })
      .eq('order_id', merchantTransactionId);

    res.redirect(data.code === "PAYMENT_SUCCESS" 
      ? `${process.env.FRONTEND_URL}/payment-success?id=${merchantTransactionId}`
      : `${process.env.FRONTEND_URL}/payment-failed?id=${merchantTransactionId}`
    );
  } catch (error) {
    console.error("Payment callback error:", error);
    res.redirect(`${process.env.FRONTEND_URL}/payment-failed`);
  }
});

app.get("/orders", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('orders')
      .select('*')
      .order('created_at', { ascending: false });

    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/order/:id", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('orders')
      .select('*')
      .eq('order_id', req.params.id)
      .single();

    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 8000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
