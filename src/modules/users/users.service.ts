import { Injectable, ConflictException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { CreateUserDto } from './dto/create-user.dto';
import * as bcrypt from 'bcrypt';
import { User, UserDocument } from './schemas/user.schema';

@Injectable()
export class UsersService {
  constructor(
    @InjectModel(User.name)
    private readonly userModel: Model<UserDocument>,
  ) {}

  /**
   * Get all users
   */
  async findAll(): Promise<UserDocument[]> {
    return this.userModel.find().exec();
  }

  /**
   * Find user by ID
   */
  async findById(id: string): Promise<UserDocument | null> {
    return this.userModel.findById(id).exec();
  }

  /**
   * Find user by national ID
   */
  async findByNationalId(nationalId: string): Promise<UserDocument | null> {
    return this.userModel.findOne({ nationalId }).exec();
  }

  /**
   * Find user by phone number with password hash selected
   * Used during authentication to retrieve the stored password hash
   */
  async findByPhoneNumberWithPassword(
    phoneNumber: string,
  ): Promise<UserDocument | null> {
    return this.userModel
      .findOne({ phoneNumber })
      .select('+passwordHash')
      .exec();
  }

  /**
   * Find user by phone number only
   */
  async findByPhoneNumber(
    phoneNumber: string,
  ): Promise<UserDocument | null> {
    return this.userModel.findOne({ phoneNumber }).exec();
  }

  /**
   * Create a new user
   * @param createUserDto - User registration data
   * @note The nationalId is hashed and stored as the user's password
   *       for authentication purposes (phone number as username, national code as password)
   */
  async create(data: CreateUserDto): Promise<UserDocument> {
    // Hash the national ID to use as password hash
    const passwordHash = await bcrypt.hash(data.nationalId, 12);
    
    try {
      const user = new this.userModel({
        ...data,
        passwordHash: passwordHash,
      });

      return await user.save();
    } catch (error) {
      if (error?.code === 11000) {
        throw new ConflictException(
          'National ID or phone number already exists',
        );
      }
      throw error;
    }
  }
}

