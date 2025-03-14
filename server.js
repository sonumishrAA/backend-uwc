import express from "express";
import axios from "axios";
import crypto from "crypto";
import cors from "cors";
import { v4 as uuidv4 } from "uuid";
import { createClient } from "@supabase/supabase-js";

const app = express();
const port = 8000;

app.use(express.json());
app.use(cors({ origin: "https://uwcindia.in" }));

// Supabase Config (Tera actual credentials daalna)
const supabase = createClient(
  "https://pvtuhceijltezxhqibrv.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB2dHVoY2Vpamx0ZXp4aHFpYnJ2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Mzk0Njk1MzMsImV4cCI6MjA1NTA0NTUzM30.kw49U2pX09mV9AjqqPMbipv2Dv6aSttqCXHhJQlmisY"
);

// PhonePe Config
const MERCHANT_ID = "M22PU06UWBZNO";
const PHONEPE_KEY = "b3ac0315-843a-4560-9e49-118b67de175c";
const PHONEPE_BASE_URL = "https://api.phonepe.com/apis/hermes";

// ✅ Modified: Email-based Order Handling
app.post("/create-order", async (req, res) => {
  try {
    const { email, name, mobileNumber, amount, address, service_type } = req.body;

    // Email Validation
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: "Invalid email format" });
    }

    // Check Existing Order (Primary Key Conflict)
    const { data: existingOrder } = await supabase
      .from("orders")
      .select("email")
      .eq("email", email)
      .single();

    if (existingOrder) {
      return res.status(400).json({ error: "Email already exists in orders" });
    }

    // PhonePe Payment Initiation
    const paymentPayload = {
      merchantId: MERCHANT_ID,
      merchantTransactionId: uuidv4(),
      merchantUserId: `USER_${mobileNumber.slice(-4)}`,
      amount: Math.round(Number(amount) * 100),
      currency: "INR",
      redirectUrl: "https://uwcindia.in/payment-success",
      mobileNumber,
      paymentInstrument: { type: "PAY_PAGE" }
    };

    const base64Payload = Buffer.from(JSON.stringify(paymentPayload)).toString("base64");
    const checksum = crypto
      .createHash("sha256")
      .update(base64Payload + "/pg/v1/pay" + PHONEPE_KEY)
      .digest("hex") + "###1";

    // PhonePe API Call
    const phonePeResponse = await axios.post(
      `${PHONEPE_BASE_URL}/pg/v1/pay`,
      { request: base64Payload },
      { headers: { "X-VERIFY": checksum } }
    );

    // ✅ Supabase Insert (Email as Primary Key)
    const { error } = await supabase.from("orders").insert([{
      email, // Primary Key
      name,
      phone_no: mobileNumber,
      amount: Number(amount),
      address,
      service_type,
      payment_status: "INITIATED",
      transaction_id: paymentPayload.merchantTransactionId,
      created_at: new Date().toISOString()
    }]);

    if (error) throw error;

    res.json({
      url: phonePeResponse.data.data.instrumentResponse.redirectInfo.url,
      txnId: paymentPayload.merchantTransactionId
    });

  } catch (error) {
    console.error("Payment Error:", error);
    res.status(500).json({ 
      error: error.response?.data?.message || "Payment failed" 
    });
  }
});

// ✅ Simplified Payment Success Handler
app.post("/payment-success", async (req, res) => {
  try {
    const { transactionId } = req.body;
    
    // Update Supabase Status
    await supabase
      .from("orders")
      .update({ 
        payment_status: "SUCCESS",
        updated_at: new Date().toISOString()
      })
      .eq("transaction_id", transactionId);

    res.redirect("https://uwcindia.in/success");
  } catch (error) {
    console.error("Webhook Error:", error);
    res.redirect("https://uwcindia.in/failure");
  }
});

app.listen(port, () => console.log(`Server running on port ${port}`));

