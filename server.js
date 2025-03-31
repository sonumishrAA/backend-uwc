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

// Supabase Config (Keep existing)
const supabase = createClient(
  "https://pvtuhceijltezxhqibrv.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB2dHVoY2Vpamx0ZXp4aHFpYnJ2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Mzk0Njk1MzMsImV4cCI6MjA1NTA0NTUzM30.kw49U2pX09mV9AjqqPMbipv2Dv6aSttqCXHhJQlmisY"
);

// 🔴 Cashfree Config (Provide these credentials)
const CASHFREE_APP_ID = "Y93963763787ea2f26f0fe1af9e736939";
const CASHFREE_SECRET_KEY = "cfsk_ma_prod_25a32122a99a0240c0653d9d12f0e985_a44c9fcf";
const CASHFREE_BASE_URL = "https://sandbox.cashfree.com/pg"; // Use production URL when live

// ✅ Payment Success Endpoint (No changes needed if using same webhook format)
app.post("/payment-success", async (req, res) => {
  /* Existing code remains same */
  try {
    const { transactionId, orderId } = req.body; // Ensure both transactionId and orderId are passed

    if (!orderId) {
      throw new Error("Order ID is missing");
    }

    // Update Supabase Status using order_id
    const { data, error } = await supabase
      .from("orders")
      .update({
        payment_status: "SUCCESS",
        updated_at: new Date().toISOString(),
      })
      .eq("order_id", orderId); // Match with order_id

    if (error || !data.length) {
      throw new Error("Failed to update payment status or no matching order found");
    }

    console.log("Payment status updated successfully:", data);

    // Redirect to success page
    res.redirect("https://uwcindia.in/success");
  } catch (error) {
    console.error("Webhook Error:", error.message);
    res.redirect("https://uwcindia.in/failure");
  }
});

// ✅ Modified Create Order Endpoint for Cashfree
app.post("/create-order", async (req, res) => {
  try {
    const { email, name, mobileNumber, amount, address, service_type } = req.body;
    const orderId = uuidv4();

    // Cashfree Payment Payload
    const paymentPayload = {
      payment_session_id: uuidv4(),
      order_id: orderId,
      customer_details: {
        customer_id: `USER_${mobileNumber.slice(-4)}`,
        customer_phone: mobileNumber,
        customer_name: name,
        customer_email: email
      },
      order_amount: Number(amount),
      order_currency: "INR",
      order_note: service_type,
      // Add return_url in Cashfree dashboard settings
    };

    // Cashfree Signature Generation
    const signatureData = `${paymentPayload.order_id}${paymentPayload.order_amount}${CASHFREE_SECRET_KEY}`;
    const signature = crypto
      .createHash("sha256")
      .update(signatureData)
      .digest("hex");

    // Cashfree API Call
    const cashfreeResponse = await axios.post(
      `${CASHFREE_BASE_URL}/orders`,
      paymentPayload,
      {
        headers: {
          "x-client-id": CASHFREE_APP_ID,
          "x-client-secret": CASHFREE_SECRET_KEY,
          "x-api-version": "2022-09-01",
          "Content-Type": "application/json"
        }
      }
    );

    // ✅ Existing Supabase Insert (No changes)
    const { error } = await supabase.from("orders").insert([{
      order_id: orderId,
      email,
      name,
      phone_no: mobileNumber,
      amount: Number(amount),
      address,
      service_type,
      payment_status: "INITIATED",
      transaction_id: paymentPayload.payment_session_id,
      created_at: new Date().toISOString()
    }]);

    if (error) throw error;

    res.json({ 
      url: cashfreeResponse.data.payment_link, // Cashfree payment URL
      txnId: paymentPayload.payment_session_id
    });
  } catch (error) {
    console.error("Payment Error:", error);
    res.status(500).json({ 
      error: error.response?.data?.message || "Payment failed" 
    });
  }
});

app.listen(port, () => console.log(`Server running on port ${port}`));
