import mongoose from 'mongoose';

const appointmentBookingSchema = new mongoose.Schema(
  {
    workflowId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Workflow',
      required: true,
      index: true
    },
    nodeId: {
      type: String,
      required: true,
      trim: true,
      index: true
    },
    callSid: {
      type: String,
      required: true,
      trim: true,
      index: true
    },
    slotKey: {
      type: String,
      required: true,
      trim: true,
      index: true
    },
    slotLabel: {
      type: String,
      required: true,
      trim: true
    },
    slotStart: {
      type: String,
      default: '',
      trim: true
    },
    slotEnd: {
      type: String,
      default: '',
      trim: true
    },
    slotDate: {
      type: String,
      required: true,
      trim: true,
      index: true
    },
    timezone: {
      type: String,
      default: 'Asia/Kolkata',
      trim: true
    },
    tokenNumber: {
      type: String,
      default: '',
      trim: true,
      index: true
    },
    bookingReference: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      index: true
    },
    customerName: {
      type: String,
      default: '',
      trim: true
    },
    customerPhone: {
      type: String,
      default: '',
      trim: true,
      index: true
    },
    customerEmail: {
      type: String,
      default: '',
      trim: true
    },
    notes: {
      type: String,
      default: '',
      trim: true
    },
    status: {
      type: String,
      enum: ['reserved', 'confirmed', 'cancelled', 'rejected'],
      default: 'confirmed',
      index: true
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {}
    }
  },
  {
    timestamps: true
  }
);

appointmentBookingSchema.index({ workflowId: 1, nodeId: 1, slotKey: 1, slotDate: 1, status: 1 });
appointmentBookingSchema.index({ callSid: 1, workflowId: 1 }, { unique: true });

const AppointmentBooking = mongoose.model('AppointmentBooking', appointmentBookingSchema);

export default AppointmentBooking;
