import express from "express";
import axios from "axios";
import crypto from "crypto";
import cors from "cors";
import { v4 as uuidv4 } from "uuid";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

// Load environment variables
dotenv.config();

const app = express();

// Middleware
app.use(express.json());
app.use(cors());

// Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// PhonePe credentials
const MERCHANT_KEY = process.env.MERCHANT_KEY;
const MERCHANT_ID = process.env.MERCHANT_ID;
const MERCHANT_BASE_URL = "https://api.phonepe.com/apis/hermes/pg/v1/pay";
const redirectUrl = "https://uwcindia.in/payment-success";

// Create payment order
app.post("/create-order", async (req, res) => {
  try {
    const { name, mobileNumber, amount, address, service } = req.body;

    // Validate required fields
    if (!name || !mobileNumber || !amount || !address || !service) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const orderId = uuidv4(); // Generate a unique order ID

    // Save order to Supabase
    const { data: order, error: orderError } = await supabase
      .from("orders")
      .insert([
        {
          id: orderId,
          name,
          phone: mobileNumber,
          address,
          service,
          amount,
          status: "pending",
        },
      ])
      .select()
      .single();

    if (orderError) {
      console.error("Error saving order to Supabase:", orderError);
      return res.status(500).json({ error: "Failed to save order details" });
    }

    // Prepare PhonePe payload
    const paymentPayload = {
      merchantId: MERCHANT_ID,
      merchantUserId: name,
      mobileNumber: mobileNumber,
      amount: amount * 100, // Convert to paisa
      merchantTransactionId: orderId,
      redirectUrl: `${redirectUrl}?orderId=${orderId}`,
      redirectMode: "POST",
      paymentInstrument: {
        type: "UPI_QR_CODE",
      },
    };

    // Generate checksum
    const payload = Buffer.from(JSON.stringify(paymentPayload)).toString("base64");
    const keyIndex = 1;
    const string = payload + "/pg/v1/pay" + MERCHANT_KEY;
    const sha256 = crypto.createHash("sha256").update(string).digest("hex");
    const checksum = sha256 + "###" + keyIndex;

    // Make API request to PhonePe
    const response = await axios.post(
      MERCHANT_BASE_URL,
      { request: payload },
      {
        headers: {
          "Content-Type": "application/json",
          "X-VERIFY": checksum,
        },
      }
    );

    // Check if payment initiation was successful
    if (response.data.success && response.data.data.instrumentResponse) {
      return res.status(200).json({
        msg: "OK",
        url: response.data.data.instrumentResponse.redirectInfo.url,
      });
    } else {
      console.error("Payment initiation failed:", response.data);
      return res.status(500).json({ error: "Failed to initiate payment", details: response.data });
    }
  } catch (error) {
    console.error("Error in /create-order:", error.response?.data || error.message);
    res.status(500).json({ error: "Internal Server Error", details: error.message });
  }
});

// Handle successful payment
app.post("/payment-success", async (req, res) => {
  try {
    const { orderId } = req.query;

    if (!orderId) {
      return res.status(400).json({ error: "Order ID is required" });
    }

    // Update order status to "success" in Supabase
    const { data: updatedOrder, error: updateError } = await supabase
      .from("orders")
      .update({ status: "success" })
      .eq("id", orderId)
      .select()
      .single();

    if (updateError) {
      console.error("Error updating order status:", updateError);
      return res.status(500).json({ error: "Failed to update order status" });
    }

    // Redirect to the frontend success page with payment details
    res.redirect(
      `https://uwcindia.in/payment-success?orderId=${orderId}&name=${encodeURIComponent(
        updatedOrder.name
      )}&phone=${encodeURIComponent(
        updatedOrder.phone
      )}&address=${encodeURIComponent(
        updatedOrder.address
      )}&service=${encodeURIComponent(updatedOrder.service)}&amount=${
        updatedOrder.amount
      }`
    );
  } catch (error) {
    console.error("Error handling payment success:", error);
    res.status(500).json({ error: "Failed to handle payment success" });
  }
});

// Handle failed payment
app.post("/payment-failed", async (req, res) => {
  try {
    const { orderId, errorMessage } = req.query;

    if (!orderId) {
      return res.status(400).json({ error: "Order ID is required" });
    }

    // Update order status to "failed" in Supabase
    const { data: updatedOrder, error: updateError } = await supabase
      .from("orders")
      .update({ status: "failed" })
      .eq("id", orderId)
      .select()
      .single();

    if (updateError) {
      console.error("Error updating order status:", updateError);
      return res.status(500).json({ error: "Failed to update order status" });
    }

    // Redirect to the frontend failed payment page with error details
    res.redirect(
      `https://uwcindia.in/payment-failed?orderId=${orderId}&error=${encodeURIComponent(
        errorMessage || "Payment failed due to an error"
      )}`
    );
  } catch (error) {
    console.error("Error handling payment failure:", error);
    res.status(500).json({ error: "Failed to handle payment failure" });
  }
});

// Start server
const PORT = process.env.PORT || 8000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
